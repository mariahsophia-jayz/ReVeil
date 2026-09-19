/**
 * Scope resolution for the Lua front end.
 *
 * Two jobs:
 *  1. rename every declared local to a globally unique identifier so that the
 *     compiler never has to deal with shadowing;
 *  2. compute, for every function, the ordered list of captured names
 *     (upvalues) which is what the VM needs to build closures.
 */

import type { Block, Chunk, Expression, FunctionExpression, Statement } from "./ast";
import type { ReVeilRandom } from "../core/rng";

export interface FnScope {
  parent: FnScope | null;
  /** Identifier of the function node (or "root"). */
  id: number;
  /** Every local declared anywhere inside this function. */
  declared: Set<string>;
  /** Ordered upvalue names captured from enclosing functions. */
  upvals: string[];
  captured: Set<string>;
}

export interface ResolveResult {
  /** Names of locals that are captured by at least one nested function. */
  captured: Set<string>;
  /** FnScope per FunctionExpression node. */
  scopes: WeakMap<object, FnScope>;
  rootScope: FnScope;
  renamed: number;
}

export function resolveChunk(chunk: Chunk, rng: ReVeilRandom): ResolveResult {
  const captured = new Set<string>();
  const scopes = new WeakMap<object, FnScope>();
  let counter = 0;
  let renamed = 0;

  const makeScope = (node: object | null, parent: FnScope | null): FnScope => {
    const scope: FnScope = {
      parent,
      id: counter,
      declared: new Set<string>(),
      upvals: [],
      captured: new Set<string>(),
    };
    counter += 1;
    if (node) {
      scopes.set(node, scope);
    }
    return scope;
  };

  const rootScope = makeScope(null, null);

  // ---------------------------------------------------------------- pass 1
  // Rename declarations and collect the declared names of every function.
  interface Frame {
    scope: FnScope;
    names: Map<string, string>[];
  }

  const renameBlock = (block: Block, frame: Frame): void => {
    for (const statement of block.statements) {
      renameStatement(statement, frame);
    }
  };

  const declare = (frame: Frame, name: string): string => {
    const fresh = rng.identifier(1, 3);
    renamed += 1;
    frame.scope.declared.add(fresh);
    const top = frame.names[frame.names.length - 1];
    top.set(name, fresh);
    return fresh;
  };

  const resolveName = (frame: Frame, name: string): string => {
    for (let index = frame.names.length - 1; index >= 0; index -= 1) {
      const found = frame.names[index].get(name);
      if (found) {
        return found;
      }
    }
    return name;
  };

  const renameFunction = (func: FunctionExpression, parentFrame: Frame): void => {
    // Each function gets its own scope so capture analysis can walk the chain.
    // The name stack is inherited so references to enclosing locals still
    // resolve to the names they were rewritten to.
    const scope = makeScope(func, parentFrame.scope);
    const frame: Frame = { scope, names: [...parentFrame.names, new Map<string, string>()] };
    func.params = func.params.map((param) => {
      const fresh = declare(frame, param);
      // The rename is stored back on the node so the compiler sees it too.
      return fresh;
    });
    renameBlock(func.body, frame);
  };

  const renameExpression = (expression: Expression, frame: Frame): void => {
    switch (expression.type) {
      case "Identifier": {
        expression.name = resolveName(frame, expression.name);
        return;
      }
      case "MemberExpression": {
        renameExpression(expression.base, frame);
        if (expression.computed && expression.indexer) {
          renameExpression(expression.indexer, frame);
        }
        return;
      }
      case "CallExpression": {
        renameExpression(expression.base, frame);
        for (const arg of expression.args) {
          renameExpression(arg, frame);
        }
        return;
      }
      case "BinaryExpression": {
        renameExpression(expression.left, frame);
        renameExpression(expression.right, frame);
        return;
      }
      case "UnaryExpression": {
        renameExpression(expression.argument, frame);
        return;
      }
      case "TableConstructor": {
        for (const field of expression.fields) {
          if (field.kind === "computed") {
            renameExpression(field.key, frame);
          }
          renameExpression(field.value, frame);
        }
        return;
      }
      case "FunctionExpression": {
        renameFunction(expression, frame);
        return;
      }
      case "IfExpression": {
        for (const clause of expression.clauses) {
          renameExpression(clause.condition, frame);
          renameExpression(clause.value, frame);
        }
        renameExpression(expression.elseValue, frame);
        return;
      }
      case "InterpolatedString": {
        for (const part of expression.parts) {
          if (part.kind === "expr") {
            renameExpression(part.expression, frame);
          }
        }
        return;
      }
      default:
        return;
    }
  };

  const renameStatement = (statement: Statement, frame: Frame): void => {
    switch (statement.type) {
      case "LocalStatement": {
        for (const expression of statement.exprs) {
          renameExpression(expression, frame);
        }
        statement.names = statement.names.map((name) => declare(frame, name));
        return;
      }
      case "AssignmentStatement": {
        for (const target of statement.targets) {
          if (target.type === "MemberExpression") {
            renameExpression(target.base, frame);
            if (target.computed && target.indexer) {
              renameExpression(target.indexer, frame);
            }
          }
        }
        for (const expression of statement.exprs) {
          renameExpression(expression, frame);
        }
        for (const target of statement.targets) {
          if (target.type === "Identifier") {
            target.name = resolveName(frame, target.name);
          }
        }
        return;
      }
      case "CompoundAssignmentStatement": {
        if (statement.target.type === "MemberExpression") {
          renameExpression(statement.target.base, frame);
          if (statement.target.computed && statement.target.indexer) {
            renameExpression(statement.target.indexer, frame);
          }
        } else {
          statement.target.name = resolveName(frame, statement.target.name);
        }
        renameExpression(statement.value, frame);
        return;
      }
      case "CallStatement": {
        renameExpression(statement.call, frame);
        return;
      }
      case "FunctionDeclaration": {
        if (statement.isLocal) {
          const fresh = declare(frame, (statement.target as { name: string }).name);
          (statement.target as { name: string }).name = fresh;
          renameFunction(statement.func, frame);
          return;
        }
        if (statement.target.type === "MemberExpression") {
          renameExpression(statement.target.base, frame);
        } else {
          statement.target.name = resolveName(frame, statement.target.name);
        }
        renameFunction(statement.func, frame);
        return;
      }
      case "DoStatement":
      case "WhileStatement": {
        if (statement.type === "WhileStatement") {
          renameExpression(statement.condition, frame);
        }
        frame.names.push(new Map());
        renameBlock(statement.body, frame);
        frame.names.pop();
        return;
      }
      case "RepeatStatement": {
        frame.names.push(new Map());
        renameBlock(statement.body, frame);
        renameExpression(statement.condition, frame);
        frame.names.pop();
        return;
      }
      case "IfStatement": {
        for (const clause of statement.clauses) {
          renameExpression(clause.condition, frame);
          frame.names.push(new Map());
          renameBlock(clause.body, frame);
          frame.names.pop();
        }
        if (statement.elseBody) {
          frame.names.push(new Map());
          renameBlock(statement.elseBody, frame);
          frame.names.pop();
        }
        return;
      }
      case "NumericForStatement": {
        renameExpression(statement.start, frame);
        renameExpression(statement.limit, frame);
        if (statement.step) {
          renameExpression(statement.step, frame);
        }
        frame.names.push(new Map());
        statement.variable = declare(frame, statement.variable);
        renameBlock(statement.body, frame);
        frame.names.pop();
        return;
      }
      case "GenericForStatement": {
        for (const expression of statement.exprs) {
          renameExpression(expression, frame);
        }
        frame.names.push(new Map());
        statement.variables = statement.variables.map((name) => declare(frame, name));
        renameBlock(statement.body, frame);
        frame.names.pop();
        return;
      }
      case "ReturnStatement": {
        for (const expression of statement.args) {
          renameExpression(expression, frame);
        }
        return;
      }
      case "GotoStatement":
      case "LabelStatement":
      case "BreakStatement":
      case "ContinueStatement":
      default:
        return;
    }
  };

  // The chunk itself behaves like the body of a vararg function.
  renameBlock(chunk.block, { scope: rootScope, names: [new Map<string, string>()] });

  // ---------------------------------------------------------------- pass 2
  // Capture analysis: resolve every referenced name against the function chain.
  const chain: FnScope[] = [];

  const markUpvalue = (from: FnScope, owner: FnScope, name: string): void => {
    let cursor: FnScope | null = from;
    while (cursor && cursor !== owner) {
      if (!cursor.upvals.includes(name)) {
        cursor.upvals.push(name);
      }
      cursor = cursor.parent;
    }
    captured.add(name);
  };

  const resolveReference = (name: string): void => {
    const current = chain[chain.length - 1];
    if (current.declared.has(name)) {
      return;
    }
    let cursor: FnScope | null = current.parent;
    while (cursor) {
      if (cursor.declared.has(name)) {
        markUpvalue(current, cursor, name);
        return;
      }
      cursor = cursor.parent;
    }
  };

  const walkExpression = (expression: Expression): void => {
    switch (expression.type) {
      case "Identifier":
        resolveReference(expression.name);
        return;
      case "MemberExpression":
        walkExpression(expression.base);
        if (expression.computed && expression.indexer) {
          walkExpression(expression.indexer);
        }
        return;
      case "CallExpression":
        walkExpression(expression.base);
        for (const arg of expression.args) {
          walkExpression(arg);
        }
        return;
      case "BinaryExpression":
        walkExpression(expression.left);
        walkExpression(expression.right);
        return;
      case "UnaryExpression":
        walkExpression(expression.argument);
        return;
      case "TableConstructor":
        for (const field of expression.fields) {
          if (field.kind === "computed") {
            walkExpression(field.key);
          }
          walkExpression(field.value);
        }
        return;
      case "FunctionExpression":
        walkFunction(expression);
        return;
      case "IfExpression":
        for (const clause of expression.clauses) {
          walkExpression(clause.condition);
          walkExpression(clause.value);
        }
        walkExpression(expression.elseValue);
        return;
      case "InterpolatedString":
        for (const part of expression.parts) {
          if (part.kind === "expr") {
            walkExpression(part.expression);
          }
        }
        return;
      default:
        return;
    }
  };

  const walkBlock = (block: Block): void => {
    for (const statement of block.statements) {
      walkStatement(statement);
    }
  };

  const walkFunction = (func: FunctionExpression): void => {
    const scope = scopes.get(func);
    if (!scope) {
      return;
    }
    chain.push(scope);
    walkBlock(func.body);
    chain.pop();
  };

  const walkStatement = (statement: Statement): void => {
    switch (statement.type) {
      case "LocalStatement": {
        for (const expression of statement.exprs) {
          walkExpression(expression);
        }
        return;
      }
      case "AssignmentStatement": {
        for (const expression of statement.exprs) {
          walkExpression(expression);
        }
        for (const target of statement.targets) {
          if (target.type === "MemberExpression") {
            walkExpression(target.base);
            if (target.computed && target.indexer) {
              walkExpression(target.indexer);
            }
          } else {
            resolveReference(target.name);
          }
        }
        return;
      }
      case "CompoundAssignmentStatement": {
        walkExpression(statement.value);
        if (statement.target.type === "MemberExpression") {
          walkExpression(statement.target.base);
          if (statement.target.computed && statement.target.indexer) {
            walkExpression(statement.target.indexer);
          }
        } else {
          resolveReference(statement.target.name);
        }
        return;
      }
      case "CallStatement":
        walkExpression(statement.call);
        return;
      case "FunctionDeclaration": {
        if (statement.target.type === "MemberExpression") {
          walkExpression(statement.target.base);
        } else if (!statement.isLocal) {
          resolveReference(statement.target.name);
        }
        walkFunction(statement.func);
        return;
      }
      case "DoStatement":
        walkBlock(statement.body);
        return;
      case "WhileStatement":
        walkExpression(statement.condition);
        walkBlock(statement.body);
        return;
      case "RepeatStatement":
        walkBlock(statement.body);
        walkExpression(statement.condition);
        return;
      case "IfStatement":
        for (const clause of statement.clauses) {
          walkExpression(clause.condition);
          walkBlock(clause.body);
        }
        if (statement.elseBody) {
          walkBlock(statement.elseBody);
        }
        return;
      case "NumericForStatement":
        walkExpression(statement.start);
        walkExpression(statement.limit);
        if (statement.step) {
          walkExpression(statement.step);
        }
        walkBlock(statement.body);
        return;
      case "GenericForStatement":
        for (const expression of statement.exprs) {
          walkExpression(expression);
        }
        walkBlock(statement.body);
        return;
      case "ReturnStatement":
        for (const expression of statement.args) {
          walkExpression(expression);
        }
        return;
      default:
        return;
    }
  };

  chain.push(rootScope);
  walkBlock(chunk.block);
  chain.pop();

  return { captured, scopes, rootScope, renamed };
}

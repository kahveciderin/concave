import { getTableColumns, InferSelectModel } from "drizzle-orm";
import {
  and,
  eq,
  not,
  or,
  sql,
  isNull as drizzleIsNull,
  isNotNull as drizzleIsNotNull,
  SQLWrapper,
  Table,
  TableConfig,
} from "drizzle-orm";
import { CustomOperator } from "./types";
import { FilterParseError } from "./error";

export interface FilterConfig {
  maxLength?: number;
  maxDepth?: number;
  maxNodes?: number;
  allowedOperators?: string[];
  allowedFields?: string[];
}

export const DEFAULT_FILTER_CONFIG: FilterConfig = {
  maxLength: 4096,
  maxDepth: 10,
  maxNodes: 100,
};

interface ParserContext {
  nodeCount: number;
  maxDepthSeen: number;
  config: FilterConfig;
}

const validateComplexity = (ctx: ParserContext, depth: number): void => {
  ctx.nodeCount++;
  ctx.maxDepthSeen = Math.max(ctx.maxDepthSeen, depth);

  if (ctx.config.maxNodes && ctx.nodeCount > ctx.config.maxNodes) {
    throw new FilterParseError("Filter has too many conditions", {
      suggestion: `Maximum ${ctx.config.maxNodes} conditions allowed`,
    });
  }

  if (ctx.config.maxDepth && depth > ctx.config.maxDepth) {
    throw new FilterParseError("Filter is too deeply nested", {
      suggestion: `Maximum nesting depth is ${ctx.config.maxDepth}`,
    });
  }
};

const likePatternToRegex = (pattern: string): RegExp => {
  let regex = "^";
  let i = 0;

  while (i < pattern.length) {
    const ch = pattern[i]!;

    if (ch === "\\") {
      i++;
      if (i < pattern.length) {
        regex += escapeRegexChar(pattern[i]!);
      } else {
        regex += "\\\\";
      }
    } else if (ch === "%") {
      regex += ".*";
    } else if (ch === "_") {
      regex += ".";
    } else {
      regex += escapeRegexChar(ch!);
    }

    i++;
  }

  regex += "$";
  return new RegExp(regex);
};

const escapeRegexChar = (ch: string): string => {
  return /[\\^$.*+?()[\]{}|]/.test(ch) ? "\\" + ch : ch;
};

const safeCompare = (a: unknown, b: unknown): number => {
  const tryNumber = (v: unknown) => {
    if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
    if (typeof v === "string") {
      const n = parseFloat(v.trim());
      return Number.isFinite(n) ? n : NaN;
    }
    return NaN;
  };

  const aNum = tryNumber(a);
  const bNum = tryNumber(b);

  const eitherIsNumberLike =
    typeof a === "number" ||
    typeof b === "number" ||
    !Number.isNaN(aNum) ||
    !Number.isNaN(bNum);

  if (eitherIsNumberLike && !Number.isNaN(aNum) && !Number.isNaN(bNum)) {
    if (aNum < bNum) return -1;
    if (aNum > bNum) return 1;
    return 0;
  }

  const aStr = String(a);
  const bStr = String(b);

  const cmp = aStr.localeCompare(bStr);
  if (cmp < 0) return -1;
  if (cmp > 0) return 1;
  return 0;
};

export interface OperatorDefinition {
  op: string;
  convert: (lhs: SQLWrapper, rhs: SQLWrapper) => SQLWrapper;
  execute: (lhs: unknown, rhs: unknown) => boolean;
}

export interface CompiledFilterExpression {
  print(): string;
  convert(): SQLWrapper;
  execute(object: Record<string, unknown>): boolean;
}

export const createResourceFilter = <TConfig extends TableConfig>(
  schema: Table<TConfig>,
  customOperators: Record<string, CustomOperator> = {},
  filterConfig: FilterConfig = DEFAULT_FILTER_CONFIG
) => {
  type SchemaType = InferSelectModel<typeof schema>;

  const config = { ...DEFAULT_FILTER_CONFIG, ...filterConfig };

  const builtinOperators: OperatorDefinition[] = [
    {
      op: "!%=",
      convert: (lhs, rhs) => sql`${lhs} NOT LIKE ${rhs}`,
      execute: (lhs, rhs) => {
        const regex = likePatternToRegex(String(rhs));
        return !regex.test(String(lhs));
      },
    },
    {
      op: "==",
      convert: (lhs, rhs) => eq(lhs, rhs),
      execute: (lhs, rhs) => String(lhs) === String(rhs),
    },
    {
      op: "!=",
      convert: (lhs, rhs) => not(eq(lhs, rhs)),
      execute: (lhs, rhs) => String(lhs) !== String(rhs),
    },
    {
      op: ">=",
      convert: (lhs, rhs) => sql`${lhs} >= ${rhs}`,
      execute: (lhs, rhs) => safeCompare(lhs, rhs) >= 0,
    },
    {
      op: "<=",
      convert: (lhs, rhs) => sql`${lhs} <= ${rhs}`,
      execute: (lhs, rhs) => safeCompare(lhs, rhs) <= 0,
    },
    {
      op: "%=",
      convert: (lhs, rhs) => sql`${lhs} LIKE ${rhs}`,
      execute: (lhs, rhs) => {
        const regex = likePatternToRegex(String(rhs));
        return regex.test(String(lhs));
      },
    },
    {
      op: ">",
      convert: (lhs, rhs) => sql`${lhs} > ${rhs}`,
      execute: (lhs, rhs) => safeCompare(lhs, rhs) > 0,
    },
    {
      op: "<",
      convert: (lhs, rhs) => sql`${lhs} < ${rhs}`,
      execute: (lhs, rhs) => safeCompare(lhs, rhs) < 0,
    },
    {
      op: "=isnull=",
      convert: (lhs, rhs) => {
        const checkNull = String(rhs).toLowerCase() === "true";
        return checkNull ? drizzleIsNull(lhs) : drizzleIsNotNull(lhs);
      },
      execute: (lhs, rhs) => {
        const checkNull = String(rhs).toLowerCase() === "true";
        return checkNull ? lhs === null || lhs === undefined : lhs !== null && lhs !== undefined;
      },
    },
    {
      op: "=in=",
      convert: (lhs, rhs) => sql`${lhs} IN (${rhs})`,
      execute: (lhs, rhs) => {
        const arr = Array.isArray(rhs) ? rhs : [rhs];
        return arr.some((item) => String(item) === String(lhs));
      },
    },
    {
      op: "=out=",
      convert: (lhs, rhs) => sql`${lhs} NOT IN (${rhs})`,
      execute: (lhs, rhs) => {
        const arr = Array.isArray(rhs) ? rhs : [rhs];
        return !arr.some((item) => String(item) === String(lhs));
      },
    },
  ];

  const customOperatorsList: OperatorDefinition[] = Object.entries(
    customOperators
  ).map(([op, def]) => ({
    op,
    convert: def.convert,
    execute: def.execute,
  }));

  const allOperators = [...builtinOperators, ...customOperatorsList];

  abstract class FilterExpression implements CompiledFilterExpression {
    abstract print(): string;
    abstract convert(): SQLWrapper;
    abstract execute(object: SchemaType): boolean;
  }

  class EmptyFilterExpression extends FilterExpression {
    print(): string {
      return "";
    }

    convert(): SQLWrapper {
      return sql`1 = 1`;
    }

    execute(_object: SchemaType): boolean {
      return true;
    }
  }

  abstract class FilterValue {
    abstract print(): string;
    abstract convert(): SQLWrapper;
    abstract execute(object: SchemaType): unknown;
  }

  class ColumnFilterValue extends FilterValue {
    constructor(private columnName: string) {
      super();
    }

    print(): string {
      return this.columnName;
    }

    convert(): SQLWrapper {
      const columns = getTableColumns(schema);
      if (!(this.columnName in columns)) {
        throw new FilterParseError(`Unknown column: ${this.columnName}`);
      }

      return schema[this.columnName as keyof typeof schema] as SQLWrapper;
    }

    execute(object: SchemaType): unknown {
      return (object as Record<string, unknown>)[this.columnName];
    }
  }

  class StringFilterValue extends FilterValue {
    constructor(private value: string) {
      super();
    }

    print(): string {
      return `"${this.value}"`;
    }

    convert(): SQLWrapper {
      return sql`${this.value}`;
    }

    execute(_object: SchemaType): unknown {
      return this.value;
    }
  }

  class NumberFilterValue extends FilterValue {
    constructor(private value: number) {
      super();
    }

    print(): string {
      return this.value.toString();
    }

    convert(): SQLWrapper {
      return sql`${this.value}`;
    }

    execute(_object: SchemaType): unknown {
      return this.value;
    }
  }

  class BooleanFilterValue extends FilterValue {
    constructor(private value: boolean) {
      super();
    }

    print(): string {
      return this.value.toString();
    }

    convert(): SQLWrapper {
      return sql`${this.value}`;
    }

    execute(_object: SchemaType): unknown {
      return this.value;
    }
  }

  class NullFilterValue extends FilterValue {
    print(): string {
      return "null";
    }

    convert(): SQLWrapper {
      return sql`NULL`;
    }

    execute(_object: SchemaType): unknown {
      return null;
    }
  }

  class SetFilterValue extends FilterValue {
    constructor(private values: FilterValue[]) {
      super();
    }

    print(): string {
      return `(${this.values.map((v) => v.print()).join(", ")})`;
    }

    convert(): SQLWrapper {
      const converted = this.values.map((v) => v.convert());
      return sql.join(converted, sql`, `);
    }

    execute(object: SchemaType): unknown {
      return this.values.map((v) => v.execute(object));
    }
  }

  class OperationFilterExpression extends FilterExpression {
    constructor(
      private field: string,
      private operator: string,
      private value: FilterValue
    ) {
      super();
    }

    print(): string {
      return `(${this.field} ${this.operator} ${this.value.print()})`;
    }

    convert(): SQLWrapper {
      const opDef = allOperators.find((op) => op.op === this.operator);
      if (!opDef) {
        throw new FilterParseError(`Unknown operator: ${this.operator}`);
      }

      const lhs = new ColumnFilterValue(this.field).convert();
      const rhs = this.value.convert();
      return opDef.convert(lhs, rhs);
    }

    execute(object: SchemaType): boolean {
      const opDef = allOperators.find((op) => op.op === this.operator);
      if (!opDef) {
        throw new FilterParseError(`Unknown operator: ${this.operator}`);
      }

      const lhs = new ColumnFilterValue(this.field).execute(object);
      const rhs = this.value.execute(object);
      return opDef.execute(lhs, rhs);
    }
  }

  class AndFilterExpression extends FilterExpression {
    constructor(private expressions: FilterExpression[]) {
      super();
    }

    print(): string {
      return (
        "(" + this.expressions.map((expr) => expr.print()).join(" AND ") + ")"
      );
    }

    convert(): SQLWrapper {
      return and(...this.expressions.map((expr) => expr.convert()))!;
    }

    execute(object: SchemaType): boolean {
      for (const expr of this.expressions) {
        if (!expr.execute(object)) {
          return false;
        }
      }
      return true;
    }

    addExpression(expr: FilterExpression) {
      this.expressions.push(expr);
    }
  }

  class OrFilterExpression extends FilterExpression {
    constructor(private expressions: FilterExpression[]) {
      super();
    }

    print(): string {
      return (
        "(" + this.expressions.map((expr) => expr.print()).join(" OR ") + ")"
      );
    }

    convert(): SQLWrapper {
      return or(...this.expressions.map((expr) => expr.convert()))!;
    }

    execute(object: SchemaType): boolean {
      for (const expr of this.expressions) {
        if (expr.execute(object)) {
          return true;
        }
      }
      return false;
    }

    addExpression(expr: FilterExpression) {
      this.expressions.push(expr);
    }
  }

  const skipWhitespace = (string: string): string => {
    return string.replace(/^\s+/, "");
  };

  const isAlpha = (char: string): boolean => {
    return /^[A-Za-z_]$/.test(char);
  };

  const isDigit = (char: string): boolean => {
    return /^[0-9]$/.test(char);
  };

  const isAlNum = (char: string): boolean => {
    return isAlpha(char) || isDigit(char);
  };

  const parseIdentifier = (
    expression: string
  ): { identifier: string; remaining: string } => {
    expression = skipWhitespace(expression);

    if (expression.length === 0 || !isAlpha(expression[0] ?? "")) {
      throw new FilterParseError("Invalid identifier start");
    }

    let i = 1;
    while (i < expression.length && isAlNum(expression[i] ?? "")) {
      i++;
    }
    const identifier = expression.slice(0, i);
    const remaining = expression.slice(i);
    return { identifier, remaining };
  };

  const parseOperator = (
    expression: string
  ): { operator: string; remaining: string } => {
    expression = skipWhitespace(expression);

    if (expression.length === 0) {
      throw new FilterParseError("Invalid operator start");
    }

    for (const op of allOperators) {
      if (expression.startsWith(op.op)) {
        return { operator: op.op, remaining: expression.slice(op.op.length) };
      }
    }

    if (expression[0] === "=" || expression[0] === "!") {
      let i = 1;
      while (i < expression.length && isAlpha(expression[i] ?? "")) {
        i++;
      }
      if (expression[i] !== "=") {
        throw new FilterParseError("Invalid operator format");
      }
      i++;
      const operator = expression.slice(0, i);
      const remaining = expression.slice(i);

      const opDef = allOperators.find((op) => op.op === operator);
      if (!opDef) {
        throw new FilterParseError(`Unknown operator: ${operator}`);
      }

      return { operator, remaining };
    } else {
      throw new FilterParseError("Invalid operator");
    }
  };

  const parseStringValue = (
    expression: string
  ): { value: StringFilterValue; remaining: string } => {
    if (expression[0] !== '"') {
      throw new FilterParseError("Invalid string value start");
    }
    let i = 1;
    while (i < expression.length && expression[i] !== '"') {
      if (expression[i] === "\\") {
        i += 2;
      } else {
        i++;
      }
    }
    if (i >= expression.length) {
      throw new FilterParseError("Unterminated string value");
    }
    const value = expression
      .slice(1, i)
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");

    const remaining = expression.slice(i + 1);
    return { value: new StringFilterValue(value), remaining };
  };

  const parseNumberValue = (
    expression: string
  ): { value: NumberFilterValue; remaining: string } => {
    let i = 0;
    let hasDecimal = false;

    if (expression[i] === "-" || expression[i] === "+") {
      i++;
    }

    while (i < expression.length) {
      const char = expression[i];
      if (isDigit(char ?? "")) {
        i++;
      } else if (char === "." && !hasDecimal) {
        hasDecimal = true;
        i++;
      } else {
        break;
      }
    }

    if (
      i === 0 ||
      (i === 1 && (expression[0] === "-" || expression[0] === "+"))
    ) {
      throw new FilterParseError("Invalid number value");
    }

    const numStr = expression.slice(0, i);
    const value = new NumberFilterValue(parseFloat(numStr));
    const remaining = expression.slice(i);
    return { value, remaining };
  };

  const parseValue = (
    expression: string
  ): { value: FilterValue; remaining: string } => {
    expression = skipWhitespace(expression);
    if (expression.length === 0) {
      throw new FilterParseError("Invalid value", {
        suggestion: "Expected a value (string, number, boolean, or null)",
      });
    }

    if (expression[0] === '"') {
      return parseStringValue(expression);
    } else if (
      isDigit(expression[0] ?? "") ||
      expression[0] === "-" ||
      expression[0] === "+" ||
      expression[0] === "."
    ) {
      return parseNumberValue(expression);
    } else if (expression[0] === "(") {
      return parseSetValue(expression);
    } else if (expression.startsWith("true")) {
      const nextChar = expression[4];
      if (!nextChar || !isAlNum(nextChar)) {
        return { value: new BooleanFilterValue(true), remaining: expression.slice(4) };
      }
    } else if (expression.startsWith("false")) {
      const nextChar = expression[5];
      if (!nextChar || !isAlNum(nextChar)) {
        return { value: new BooleanFilterValue(false), remaining: expression.slice(5) };
      }
    } else if (expression.startsWith("null")) {
      const nextChar = expression[4];
      if (!nextChar || !isAlNum(nextChar)) {
        return { value: new NullFilterValue(), remaining: expression.slice(4) };
      }
    }
    
    throw new FilterParseError("Unknown value type", {
      suggestion: "Expected a quoted string, number, true, false, or null",
    });
  };

  const parseSetValue = (
    expression: string
  ): { value: SetFilterValue; remaining: string } => {
    if (expression[0] !== "(") {
      throw new FilterParseError("Invalid set value start");
    }
    const values: FilterValue[] = [];
    let expr = skipWhitespace(expression.slice(1));
    while (expr.length > 0 && expr[0] !== ")") {
      const { value, remaining } = parseValue(expr);
      values.push(value);
      expr = skipWhitespace(remaining);
      if (expr[0] === ",") {
        expr = skipWhitespace(expr.slice(1));
      } else if (expr[0] !== ")") {
        throw new FilterParseError("Invalid set value format");
      }
    }
    if (expr[0] !== ")") {
      throw new FilterParseError("Unterminated set value");
    }
    const remaining = expr.slice(1);
    return { value: new SetFilterValue(values), remaining };
  };

  const parseTerm = (
    expression: string
  ): { expr: FilterExpression; remaining: string } => {
    expression = skipWhitespace(expression);
    if (expression.startsWith("(")) {
      expression = skipWhitespace(expression.slice(1));
      const { expr: innerExpr, remaining: remAfterInner } = parseOr(expression);
      expression = skipWhitespace(remAfterInner);
      if (expression[0] !== ")") {
        throw new FilterParseError(
          "Unterminated parenthesis in filter expression"
        );
      }
      expression = skipWhitespace(expression.slice(1));
      return { expr: innerExpr, remaining: expression };
    }

    const { identifier, remaining: remAfterIdent } =
      parseIdentifier(expression);
    expression = skipWhitespace(remAfterIdent);

    const { operator, remaining: remAfterOp } = parseOperator(expression);
    expression = skipWhitespace(remAfterOp);
    const { value, remaining: remAfterValue } = parseValue(expression);
    expression = skipWhitespace(remAfterValue);

    const newExpr = new OperationFilterExpression(identifier, operator, value);

    return { expr: newExpr, remaining: expression };
  };

  const parseAnd = (
    expression: string
  ): { expr: FilterExpression; remaining: string } => {
    let ret: FilterExpression = new EmptyFilterExpression();
    expression = skipWhitespace(expression);

    while (expression.length > 0) {
      const { expr, remaining } = parseTerm(expression);
      expression = skipWhitespace(remaining);

      if (ret instanceof EmptyFilterExpression) {
        ret = expr;
      } else if (ret instanceof AndFilterExpression) {
        ret.addExpression(expr);
      } else {
        ret = new AndFilterExpression([ret, expr]);
      }

      if (
        expression.startsWith(";") ||
        expression.startsWith("&&") ||
        (expression.startsWith("and") && !isAlNum(expression[3] ?? "")) ||
        (expression.startsWith("AND") && !isAlNum(expression[3] ?? ""))
      ) {
        expression = skipWhitespace(
          expression.startsWith(";")
            ? expression.slice(1)
            : expression.startsWith("&&")
              ? expression.slice(2)
              : expression.slice(3)
        );
        continue;
      }

      break;
    }

    return { expr: ret, remaining: expression };
  };

  const parseOr = (
    expression: string
  ): { expr: FilterExpression; remaining: string } => {
    let ret: FilterExpression = new EmptyFilterExpression();
    expression = skipWhitespace(expression);

    while (expression.length > 0) {
      const { expr, remaining } = parseAnd(expression);
      expression = skipWhitespace(remaining);

      if (ret instanceof EmptyFilterExpression) {
        ret = expr;
      } else if (ret instanceof OrFilterExpression) {
        ret.addExpression(expr);
      } else {
        ret = new OrFilterExpression([ret, expr]);
      }

      if (expression.startsWith(",")) {
        expression = skipWhitespace(expression.slice(1));
        continue;
      }
      if (expression.startsWith("||")) {
        expression = skipWhitespace(expression.slice(2));
        continue;
      }
      if (expression.startsWith("or") && !isAlNum(expression[2] ?? "")) {
        expression = skipWhitespace(expression.slice(2));
        continue;
      }
      if (expression.startsWith("OR") && !isAlNum(expression[2] ?? "")) {
        expression = skipWhitespace(expression.slice(2));
        continue;
      }

      break;
    }

    return { expr: ret, remaining: expression };
  };

  const parseFilterExpression = (expression: string): FilterExpression => {
    if (!expression || expression.trim() === "") {
      return new EmptyFilterExpression();
    }

    if (config.maxLength && expression.length > config.maxLength) {
      throw new FilterParseError("Filter exceeds maximum length", {
        suggestion: `Maximum filter length is ${config.maxLength} characters`,
      });
    }

    const ctx: ParserContext = {
      nodeCount: 0,
      maxDepthSeen: 0,
      config,
    };

    const data = parseOrWithContext(expression, ctx, 0);
    if (data.remaining.length > 0) {
      throw new FilterParseError(
        `Unexpected input after parsing filter expression: ${data.remaining}`,
        {
          position: expression.length - data.remaining.length,
        }
      );
    }

    return data.expr;
  };

  const parseTermWithContext = (
    expression: string,
    ctx: ParserContext,
    depth: number
  ): { expr: FilterExpression; remaining: string } => {
    expression = skipWhitespace(expression);
    validateComplexity(ctx, depth);

    if (expression.startsWith("(")) {
      expression = skipWhitespace(expression.slice(1));
      const { expr: innerExpr, remaining: remAfterInner } = parseOrWithContext(
        expression,
        ctx,
        depth + 1
      );
      expression = skipWhitespace(remAfterInner);
      if (expression[0] !== ")") {
        throw new FilterParseError(
          "Unterminated parenthesis in filter expression",
          { position: expression.length }
        );
      }
      expression = skipWhitespace(expression.slice(1));
      return { expr: innerExpr, remaining: expression };
    }

    const { identifier, remaining: remAfterIdent } =
      parseIdentifier(expression);
    expression = skipWhitespace(remAfterIdent);

    if (config.allowedFields && !config.allowedFields.includes(identifier)) {
      throw new FilterParseError(`Field '${identifier}' is not filterable`, {
        allowedFields: config.allowedFields,
      });
    }

    const { operator, remaining: remAfterOp } = parseOperatorWithValidation(
      expression,
      config.allowedOperators
    );
    expression = skipWhitespace(remAfterOp);
    const { value, remaining: remAfterValue } = parseValue(expression);
    expression = skipWhitespace(remAfterValue);

    const newExpr = new OperationFilterExpression(identifier, operator, value);

    return { expr: newExpr, remaining: expression };
  };

  const parseAndWithContext = (
    expression: string,
    ctx: ParserContext,
    depth: number
  ): { expr: FilterExpression; remaining: string } => {
    let ret: FilterExpression = new EmptyFilterExpression();
    expression = skipWhitespace(expression);

    while (expression.length > 0) {
      const { expr, remaining } = parseTermWithContext(expression, ctx, depth);
      expression = skipWhitespace(remaining);

      if (ret instanceof EmptyFilterExpression) {
        ret = expr;
      } else if (ret instanceof AndFilterExpression) {
        ret.addExpression(expr);
      } else {
        ret = new AndFilterExpression([ret, expr]);
      }

      if (
        expression.startsWith(";") ||
        expression.startsWith("&&") ||
        (expression.startsWith("and") && !isAlNum(expression[3] ?? "")) ||
        (expression.startsWith("AND") && !isAlNum(expression[3] ?? ""))
      ) {
        expression = skipWhitespace(
          expression.startsWith(";")
            ? expression.slice(1)
            : expression.startsWith("&&")
              ? expression.slice(2)
              : expression.slice(3)
        );
        continue;
      }

      break;
    }

    return { expr: ret, remaining: expression };
  };

  const parseOrWithContext = (
    expression: string,
    ctx: ParserContext,
    depth: number
  ): { expr: FilterExpression; remaining: string } => {
    let ret: FilterExpression = new EmptyFilterExpression();
    expression = skipWhitespace(expression);

    while (expression.length > 0) {
      const { expr, remaining } = parseAndWithContext(expression, ctx, depth);
      expression = skipWhitespace(remaining);

      if (ret instanceof EmptyFilterExpression) {
        ret = expr;
      } else if (ret instanceof OrFilterExpression) {
        ret.addExpression(expr);
      } else {
        ret = new OrFilterExpression([ret, expr]);
      }

      if (expression.startsWith(",")) {
        expression = skipWhitespace(expression.slice(1));
        continue;
      }
      if (expression.startsWith("||")) {
        expression = skipWhitespace(expression.slice(2));
        continue;
      }
      if (expression.startsWith("or") && !isAlNum(expression[2] ?? "")) {
        expression = skipWhitespace(expression.slice(2));
        continue;
      }
      if (expression.startsWith("OR") && !isAlNum(expression[2] ?? "")) {
        expression = skipWhitespace(expression.slice(2));
        continue;
      }

      break;
    }

    return { expr: ret, remaining: expression };
  };

  const parseOperatorWithValidation = (
    expression: string,
    allowedOperators?: string[]
  ): { operator: string; remaining: string } => {
    expression = skipWhitespace(expression);

    if (expression.length === 0) {
      throw new FilterParseError("Invalid operator start", {
        suggestion: "Expected an operator",
      });
    }

    for (const op of allOperators) {
      if (expression.startsWith(op.op)) {
        if (allowedOperators && !allowedOperators.includes(op.op)) {
          throw new FilterParseError(`Operator '${op.op}' is not allowed`, {
            allowedOperators,
          });
        }
        return { operator: op.op, remaining: expression.slice(op.op.length) };
      }
    }

    if (expression[0] === "=" || expression[0] === "!") {
      let i = 1;
      while (i < expression.length && isAlpha(expression[i] ?? "")) {
        i++;
      }
      if (expression[i] !== "=") {
        throw new FilterParseError("Invalid operator format", {
          suggestion: "Operators must be in format =name= or symbolic (==, !=, etc.)",
        });
      }
      i++;
      const operator = expression.slice(0, i);
      const remaining = expression.slice(i);

      const opDef = allOperators.find((op) => op.op === operator);
      if (!opDef) {
        throw new FilterParseError(`Unknown operator: ${operator}`, {
          suggestion: "Use a valid operator like ==, !=, =isnull=, =in=, etc.",
          allowedOperators: allOperators.map((o) => o.op),
        });
      }

      if (allowedOperators && !allowedOperators.includes(operator)) {
        throw new FilterParseError(`Operator '${operator}' is not allowed`, {
          allowedOperators,
        });
      }

      return { operator, remaining };
    } else {
      throw new FilterParseError("Invalid operator", {
        suggestion: "Operators must start with = or ! or be symbolic (>, <, etc.)",
      });
    }
  };

  const filterCache = new Map<string, FilterExpression>();

  const getCompiledFilter = (expr: string): FilterExpression => {
    let compiled = filterCache.get(expr);
    if (!compiled) {
      compiled = parseFilterExpression(expr);
      filterCache.set(expr, compiled);
    }
    return compiled;
  };

  return {
    compile: (expr: string): CompiledFilterExpression => {
      return getCompiledFilter(expr);
    },
    convert: (expr: string): SQLWrapper => {
      const filter = getCompiledFilter(expr);
      return filter.convert();
    },
    execute: (expr: string, object: SchemaType): boolean => {
      const filter = getCompiledFilter(expr);
      return filter.execute(object);
    },
    clearCache: () => {
      filterCache.clear();
    },
    getConfig: () => config,
    getOperators: () => allOperators.map((op) => op.op),
  };
};

export type Filter = ReturnType<typeof createResourceFilter>;

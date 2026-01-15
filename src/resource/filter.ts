import { getTableColumns, InferSelectModel } from "drizzle-orm";
import {
  and,
  eq,
  like,
  not,
  or,
  sql,
  SQLWrapper,
  Table,
  TableConfig,
} from "drizzle-orm";

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

const safeCompare = (a: any, b: any): number => {
  const tryNumber = (v: any) => {
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

export const createResourceFilter = <TConfig extends TableConfig>(
  schema: Table<TConfig>
) => {
  type SchemaType = InferSelectModel<typeof schema>;

  const builtinOperators: {
    op: string;
    convert: (lhs: FilterValue, rhs: FilterValue) => SQLWrapper;
    execute: (lhs: any, rhs: any) => boolean;
  }[] = [
    {
      op: "!%=",
      convert: (lhs, rhs) => sql`${lhs.convert()} not like ${rhs.convert()}`,
      execute: (lhs, rhs) => {
        const regex = likePatternToRegex(rhs);
        return !regex.test(lhs);
      },
    },
    {
      op: "==",
      convert: (lhs, rhs) => eq(lhs.convert(), rhs.convert()),
      execute: (lhs, rhs) => lhs.toString() === rhs.toString(),
    },
    {
      op: "!=",
      convert: (lhs, rhs) => not(eq(lhs.convert(), rhs.convert())),
      execute: (lhs, rhs) => lhs.toString() !== rhs.toString(),
    },
    {
      op: ">=",
      convert: (lhs, rhs) => sql`${lhs.convert()} >= ${rhs.convert()}`,
      execute: (lhs, rhs) => safeCompare(lhs, rhs) >= 0,
    },
    {
      op: "<=",
      convert: (lhs, rhs) => sql`${lhs.convert()} <= ${rhs.convert()}`,
      execute: (lhs, rhs) => safeCompare(lhs, rhs) <= 0,
    },
    {
      op: "%=",
      convert: (lhs, rhs) => sql`${lhs.convert()} like ${rhs.convert()}`,
      execute: (lhs, rhs) => {
        const regex = likePatternToRegex(rhs);
        return regex.test(lhs);
      },
    },
    {
      op: ">",
      convert: (lhs, rhs) => sql`${lhs.convert()} > ${rhs.convert()}`,
      execute: (lhs, rhs) => safeCompare(lhs, rhs) > 0,
    },
    {
      op: "<",
      convert: (lhs, rhs) => sql`${lhs.convert()} < ${rhs.convert()}`,
      execute: (lhs, rhs) => safeCompare(lhs, rhs) < 0,
    },
  ];

  abstract class FilterExpression {
    abstract print(): string;
    abstract convert(): SQLWrapper;
    abstract execute(object: SchemaType): boolean;
  }

  class EmptyFilterExpression extends FilterExpression {
    print(): string {
      return "";
    }

    convert(): SQLWrapper {
      return eq(sql`1`, 1);
    }

    execute(object: SchemaType): boolean {
      return true;
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
      const builtinOp = builtinOperators.find((op) => op.op === this.operator);
      if (!builtinOp) {
        throw new Error("Unknown operator: " + this.operator);
      }

      return builtinOp.convert(new ColumnFilterValue(this.field), this.value)!;
    }

    execute(object: SchemaType): boolean {
      const builtinOp = builtinOperators.find((op) => op.op === this.operator);
      if (!builtinOp) {
        throw new Error("Unknown operator: " + this.operator);
      }

      const lhs = new ColumnFilterValue(this.field).execute(object);
      const rhs = this.value.execute(object);
      return builtinOp.execute(lhs, rhs);
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

  abstract class FilterValue {
    abstract print(): string;
    abstract convert(): SQLWrapper;
    abstract execute(object: SchemaType): any;
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
        throw new Error("Unknown column: " + this.columnName);
      }

      return schema[this.columnName as keyof typeof schema] as SQLWrapper;
    }

    execute(object: SchemaType): any {
      return (object as any)[this.columnName];
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

    execute(object: SchemaType): any {
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

    execute(object: SchemaType): any {
      return this.value;
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
      return sql`(${this.values.map((v) => v.convert()).join(", ")})`;
    }

    execute(object: SchemaType): any {
      return this.values.map((v) => v.execute(object));
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
      throw new Error("Invalid identifier start");
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
      throw new Error("Invalid operator start");
    }

    for (const op of builtinOperators) {
      if (expression.startsWith(op.op)) {
        return { operator: op.op, remaining: expression.slice(op.op.length) };
      }
    }

    if (expression[0] == "=" || expression[0] == "!") {
      let i = 1;
      while (i < expression.length && isAlpha(expression[i] ?? "")) {
        i++;
      }
      if (expression[i] != "=") throw new Error("Invalid operator format");
      i++;
      const operator = expression.slice(0, i);
      const remaining = expression.slice(i);
      return { operator, remaining };
    } else {
      throw new Error("Invalid operator");
    }
  };

  const parseStringValue = (
    expression: string
  ): { value: StringFilterValue; remaining: string } => {
    if (expression[0] !== '"') {
      throw new Error("Invalid string value start");
    }
    let i = 1;
    while (i < expression.length && expression[i] !== '"') {
      i++;
      if (expression[i - 1] === "\\") {
        i++;
      }
    }
    if (i >= expression.length) {
      throw new Error("Unterminated string value");
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
      throw new Error("Invalid number value");
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
      throw new Error("Invalid value");
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
    } else {
      throw new Error("Unknown value type");
    }
  };

  const parseSetValue = (
    expression: string
  ): { value: SetFilterValue; remaining: string } => {
    if (expression[0] !== "(") {
      throw new Error("Invalid set value start");
    }
    let values: FilterValue[] = [];
    let expr = skipWhitespace(expression.slice(1));
    while (expr.length > 0 && expr[0] !== ")") {
      const { value, remaining } = parseValue(expr);
      values.push(value);
      expr = skipWhitespace(remaining);
      if (expr[0] === ",") {
        expr = skipWhitespace(expr.slice(1));
      } else if (expr[0] !== ")") {
        throw new Error("Invalid set value format");
      }
    }
    if (expr[0] !== ")") {
      throw new Error("Unterminated set value");
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
        throw new Error("Unterminated parenthesis in filter expression");
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

      if (
        expression.startsWith(",") ||
        expression.startsWith("||") ||
        (expression.startsWith("or") && !isAlNum(expression[2] ?? "")) ||
        (expression.startsWith("OR") && !isAlNum(expression[2] ?? ""))
      ) {
        expression = skipWhitespace(
          expression.startsWith(",")
            ? expression.slice(1)
            : expression.startsWith("||")
              ? expression.slice(2)
              : expression.slice(2)
        );
        continue;
      }

      break;
    }

    return { expr: ret, remaining: expression };
  };

  const parseFilterExpression = (expression: string): FilterExpression => {
    const data = parseOr(expression);
    if (data.remaining.length > 0) {
      throw new Error(
        "Unexpected input after parsing filter expression: " + data.remaining
      );
    }

    return data.expr;
  };

  return {
    compile: (expr: string) => {
      return parseFilterExpression(expr);
    },
    convert: (expr: string): SQLWrapper => {
      const filter = parseFilterExpression(expr);
      return filter.convert();
    },
    execute: (expr: string, object: SchemaType): boolean => {
      const filter = parseFilterExpression(expr);
      return filter.execute(object);
    },
  };
};

export type Filter = ReturnType<typeof createResourceFilter>;

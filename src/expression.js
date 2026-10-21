// A small, safe expression language for calculator config.
//
// Expressions reference deal properties by their internal name and support
// arithmetic, comparisons, && / || / !, and a handful of functions:
//
//   ceil(licence_seats / 25)
//   services_days > 0 && hasOption(services_options, "on_site")
//   if(tier == "premium", 2, 1)
//
// Nothing is passed to eval(): source is tokenized, parsed into a tree and
// interpreted, so config files can't run arbitrary code.

export class ExpressionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExpressionError';
  }
}

const NUMERIC = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

const MATH_FUNCTIONS = {
  ceil: { min: 1, max: 1, fn: Math.ceil },
  floor: { min: 1, max: 1, fn: Math.floor },
  abs: { min: 1, max: 1, fn: Math.abs },
  round: { min: 1, max: 2, fn: roundTo },
  min: { min: 1, max: Infinity, fn: Math.min },
  max: { min: 1, max: Infinity, fn: Math.max },
};

// Functions that look at raw values (or evaluate arguments lazily) rather
// than coercing everything to numbers up front.
const VALUE_FUNCTIONS = {
  if: { min: 3, max: 3 },
  coalesce: { min: 1, max: Infinity },
  isBlank: { min: 1, max: 1 },
  hasOption: { min: 2, max: 2 },
};

const FUNCTION_NAMES = [...Object.keys(MATH_FUNCTIONS), ...Object.keys(VALUE_FUNCTIONS)];

/**
 * Compile an expression. Throws ExpressionError on invalid syntax.
 * @returns {{ source: string, identifiers: string[], evaluate(values: object): any, evaluateNumber(values: object): number }}
 */
export function compile(source) {
  let ast;
  try {
    ast = new Parser(tokenize(String(source))).parse();
  } catch (err) {
    if (err instanceof ExpressionError) {
      throw new ExpressionError(`Invalid expression "${source}": ${err.message}`);
    }
    throw err;
  }
  return {
    source: String(source),
    identifiers: [...collectIdentifiers(ast, new Set())],
    literals: [...collectLiterals(ast, new Set())],
    evaluate: (values) => evaluate(ast, values),
    evaluateNumber: (values) => toNumber(evaluate(ast, values), ast),
  };
}

/**
 * Compile a text template such as "Consultancy ({{services_days}} days)".
 * Each {{ }} holds an expression.
 */
export function compileTemplate(source) {
  const parts = [];
  const pattern = /\{\{(.*?)\}\}/g;
  let last = 0;
  for (const match of String(source).matchAll(pattern)) {
    parts.push(source.slice(last, match.index));
    parts.push(compile(match[1]));
    last = match.index + match[0].length;
  }
  parts.push(source.slice(last));
  return {
    source,
    identifiers: [...new Set(parts.flatMap((p) => (typeof p === 'string' ? [] : p.identifiers)))],
    render: (values) =>
      parts.map((p) => (typeof p === 'string' ? p : formatValue(p.evaluate(values)))).join(''),
  };
}

/**
 * Normalize HubSpot property values (always strings) for use in expressions:
 * blanks become null and checkbox values become booleans. Numeric strings
 * stay strings and are coerced when used as numbers.
 */
export function normalizeValues(properties = {}) {
  const values = {};
  for (const [name, value] of Object.entries(properties)) {
    if (value === undefined || value === null || value === '') values[name] = null;
    else if (value === 'true') values[name] = true;
    else if (value === 'false') values[name] = false;
    else values[name] = value;
  }
  return values;
}

export function truthy(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0 && !Number.isNaN(value);
  const n = asNumber(value);
  return n !== null ? n !== 0 : value.length > 0;
}

// --- Tokenizer ---------------------------------------------------------------

function tokenize(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const pos = i;
    if (/[0-9.]/.test(ch)) {
      const match = /^(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/.exec(source.slice(i));
      if (!match) throw new ExpressionError(`unexpected "${ch}" at position ${pos + 1}`);
      tokens.push({ type: 'number', value: Number(match[0]), pos });
      i += match[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const [word] = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i));
      tokens.push({ type: 'ident', value: word, pos });
      i += word.length;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let value = '';
      i++;
      while (i < source.length && source[i] !== ch) {
        if (source[i] === '\\' && i + 1 < source.length) i++;
        value += source[i++];
      }
      if (i >= source.length) throw new ExpressionError(`unterminated string at position ${pos + 1}`);
      i++;
      tokens.push({ type: 'string', value, pos });
      continue;
    }
    const two = source.slice(i, i + 2);
    if (['&&', '||', '==', '!=', '<=', '>='].includes(two)) {
      tokens.push({ type: 'op', value: two, pos });
      i += 2;
      continue;
    }
    if ('+-*/%<>!(),'.includes(ch)) {
      tokens.push({ type: 'op', value: ch, pos });
      i++;
      continue;
    }
    if (ch === '=') throw new ExpressionError(`use "==" to compare values (position ${pos + 1})`);
    if (ch === '&' || ch === '|') throw new ExpressionError(`use "${ch}${ch}" (position ${pos + 1})`);
    throw new ExpressionError(`unexpected "${ch}" at position ${pos + 1}`);
  }
  tokens.push({ type: 'eof', pos: source.length });
  return tokens;
}

// --- Parser (recursive descent, lowest precedence first) ----------------------

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.index = 0;
  }

  parse() {
    const node = this.or();
    if (this.peek().type !== 'eof') throw unexpected(this.peek());
    return node;
  }

  peek() {
    return this.tokens[this.index];
  }

  next() {
    return this.tokens[this.index++];
  }

  atOp(...ops) {
    const token = this.peek();
    return token.type === 'op' && ops.includes(token.value);
  }

  expectOp(op) {
    const token = this.next();
    if (token.type !== 'op' || token.value !== op) throw unexpected(token, `"${op}"`);
  }

  binary(ops, operand, type = 'binary') {
    let left = operand();
    while (this.atOp(...ops)) {
      const op = this.next().value;
      left = { type, op, left, right: operand() };
    }
    return left;
  }

  or() {
    return this.binary(['||'], () => this.and(), 'logical');
  }

  and() {
    return this.binary(['&&'], () => this.equality(), 'logical');
  }

  equality() {
    return this.binary(['==', '!='], () => this.comparison());
  }

  comparison() {
    return this.binary(['<', '<=', '>', '>='], () => this.additive());
  }

  additive() {
    return this.binary(['+', '-'], () => this.multiplicative());
  }

  multiplicative() {
    return this.binary(['*', '/', '%'], () => this.unary());
  }

  unary() {
    if (this.atOp('!', '-')) {
      const op = this.next().value;
      return { type: 'unary', op, operand: this.unary() };
    }
    return this.primary();
  }

  primary() {
    const token = this.next();
    if (token.type === 'number' || token.type === 'string') return { type: 'literal', value: token.value };
    if (token.type === 'ident') {
      if (token.value === 'true') return { type: 'literal', value: true };
      if (token.value === 'false') return { type: 'literal', value: false };
      if (token.value === 'null') return { type: 'literal', value: null };
      if (this.atOp('(')) return this.call(token);
      return { type: 'identifier', name: token.value };
    }
    if (token.type === 'op' && token.value === '(') {
      const node = this.or();
      this.expectOp(')');
      return node;
    }
    throw unexpected(token);
  }

  call(nameToken) {
    const name = nameToken.value;
    const spec = MATH_FUNCTIONS[name] ?? VALUE_FUNCTIONS[name];
    if (!spec) {
      throw new ExpressionError(`unknown function "${name}" (available: ${FUNCTION_NAMES.join(', ')})`);
    }
    this.expectOp('(');
    const args = [];
    if (!this.atOp(')')) {
      args.push(this.or());
      while (this.atOp(',')) {
        this.next();
        args.push(this.or());
      }
    }
    this.expectOp(')');
    if (args.length < spec.min || args.length > spec.max) {
      const expected = spec.min === spec.max ? spec.min : spec.max === Infinity ? `at least ${spec.min}` : `${spec.min}-${spec.max}`;
      throw new ExpressionError(`${name}() takes ${expected} argument(s), got ${args.length}`);
    }
    return { type: 'call', name, args };
  }
}

function unexpected(token, expected) {
  const found = token.type === 'eof' ? 'end of expression' : `"${token.value}" at position ${token.pos + 1}`;
  return new ExpressionError(`unexpected ${found}${expected ? `, expected ${expected}` : ''}`);
}

function collectIdentifiers(node, names) {
  switch (node.type) {
    case 'identifier':
      names.add(node.name);
      break;
    case 'unary':
      collectIdentifiers(node.operand, names);
      break;
    case 'binary':
    case 'logical':
      collectIdentifiers(node.left, names);
      collectIdentifiers(node.right, names);
      break;
    case 'call':
      node.args.forEach((arg) => collectIdentifiers(arg, names));
      break;
  }
  return names;
}

function collectLiterals(node, values) {
  if (node.type === 'literal') values.add(node.value);
  for (const child of [node.operand, node.left, node.right, ...(node.args ?? [])]) {
    if (child) collectLiterals(child, values);
  }
  return values;
}

// --- Evaluator -----------------------------------------------------------------

function evaluate(node, values) {
  switch (node.type) {
    case 'literal':
      return node.value;
    case 'identifier': {
      // hasOwn: names like "constructor" must not resolve to Object.prototype members.
      const value = Object.hasOwn(values, node.name) ? values[node.name] : null;
      return value === undefined || value === '' ? null : value;
    }
    case 'unary': {
      const value = evaluate(node.operand, values);
      return node.op === '!' ? !truthy(value) : -toNumber(value, node.operand);
    }
    case 'logical': {
      const left = truthy(evaluate(node.left, values));
      if (node.op === '&&') return left && truthy(evaluate(node.right, values));
      return left || truthy(evaluate(node.right, values));
    }
    case 'binary':
      return evaluateBinary(node, evaluate(node.left, values), evaluate(node.right, values));
    case 'call':
      return evaluateCall(node, values);
  }
  throw new ExpressionError(`unsupported expression node "${node.type}"`);
}

function evaluateBinary(node, left, right) {
  switch (node.op) {
    case '==':
      return looseEquals(left, right);
    case '!=':
      return !looseEquals(left, right);
    case '<':
    case '<=':
    case '>':
    case '>=':
      return compareValues(left, right, node.op);
  }
  const a = toNumber(left, node.left);
  const b = toNumber(right, node.right);
  if ((node.op === '/' || node.op === '%') && b === 0) {
    throw new ExpressionError(`division by zero${node.right.type === 'identifier' ? ` (deal property "${node.right.name}" is 0)` : ''}`);
  }
  const result = { '+': a + b, '-': a - b, '*': a * b, '/': a / b, '%': a % b }[node.op];
  return finite(result);
}

function evaluateCall(node, values) {
  const { name, args } = node;
  const math = MATH_FUNCTIONS[name];
  if (math) {
    const numbers = args.map((arg) => toNumber(evaluate(arg, values), arg));
    return finite(math.fn(...numbers));
  }
  switch (name) {
    case 'if':
      return truthy(evaluate(args[0], values)) ? evaluate(args[1], values) : evaluate(args[2], values);
    case 'coalesce':
      for (const arg of args) {
        const value = evaluate(arg, values);
        if (value !== null) return value;
      }
      return null;
    case 'isBlank':
      return evaluate(args[0], values) === null;
    case 'hasOption': {
      // HubSpot multi-select (checkbox) properties store "a;b;c".
      const value = evaluate(args[0], values);
      if (value === null) return false;
      const wanted = String(evaluate(args[1], values));
      return String(value).split(';').map((s) => s.trim()).includes(wanted);
    }
  }
  throw new ExpressionError(`unknown function "${name}"`);
}

function asNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && NUMERIC.test(value.trim())) return Number(value.trim());
  return null;
}

function toNumber(value, node) {
  const n = asNumber(value);
  if (n !== null) return n;
  const subject = node?.type === 'identifier' ? `deal property "${node.name}"` : 'a value used in a calculation';
  if (value === null || value === undefined) throw new ExpressionError(`${subject} is empty`);
  throw new ExpressionError(`${subject} is not a number (value: ${JSON.stringify(value)})`);
}

function finite(n) {
  if (!Number.isFinite(n)) throw new ExpressionError('calculation did not produce a finite number');
  return n;
}

function looseEquals(a, b) {
  if (a === null || b === null) return a === b;
  const na = asNumber(a);
  const nb = asNumber(b);
  if (na !== null && nb !== null) return na === nb;
  return String(a) === String(b);
}

function compareValues(a, b, op) {
  // Comparisons with a blank value are false, so "licence_seats > 0" is simply
  // false on deals where the calculator hasn't been filled in.
  if (a === null || b === null) return false;
  const na = asNumber(a);
  const nb = asNumber(b);
  const [x, y] = na !== null && nb !== null ? [na, nb] : [String(a), String(b)];
  switch (op) {
    case '<':
      return x < y;
    case '<=':
      return x <= y;
    case '>':
      return x > y;
    default:
      return x >= y;
  }
}

function roundTo(value, digits = 0) {
  if (!Number.isInteger(digits) || digits < 0 || digits > 10) {
    throw new ExpressionError('round() digits must be a whole number between 0 and 10');
  }
  // Exponent notation avoids binary floating point surprises such as
  // round(1.005, 2) returning 1. Values already printed in exponent form
  // (very large or tiny) fall back to plain scaling.
  if (String(value).includes('e')) return Math.round(value * 10 ** digits) / 10 ** digits;
  return Number(`${Math.round(Number(`${value}e${digits}`))}e-${digits}`);
}

function formatValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(Number(value.toFixed(6)));
  return String(value);
}

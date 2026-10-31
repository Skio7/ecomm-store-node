import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { errors } from './errors.js';

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** Prefixed, URL-safe random id, e.g. `ord_7k2m9x4q1r8t5w3z`. */
export function newId(prefix) {
  const bytes = randomBytes(16);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return `${prefix}_${out}`;
}

export const nowIso = () => new Date().toISOString();

export const paginationQuery = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};

export function pageInfo(total, page, limit) {
  const totalPages = Math.max(1, Math.ceil(total / limit));
  return { page, limit, total, totalPages, hasNext: page < totalPages, hasPrev: page > 1 };
}

export function paginate(items, page, limit) {
  const start = (page - 1) * limit;
  return { data: items.slice(start, start + limit), pagination: pageInfo(items.length, page, limit) };
}

/** Paginates a MongoDB query; `map` converts each stored document to its API shape. */
export async function paginateQuery(collection, filter, { sort, page, limit, map = (d) => d }) {
  const [docs, total] = await Promise.all([
    collection.find(filter).sort(sort).skip((page - 1) * limit).limit(limit).toArray(),
    collection.countDocuments(filter),
  ]);
  return { data: docs.map(map), pagination: pageInfo(total, page, limit) };
}

/** Runs request parts through zod; parsed values land on `req.valid`. */
export function validate(schemas) {
  const compiled = Object.fromEntries(
    Object.entries(schemas).map(([part, schema]) => [part, schema instanceof z.ZodType ? schema : z.object(schema)]),
  );
  return (req, _res, next) => {
    const valid = {};
    const issues = [];
    for (const part of ['params', 'query', 'body']) {
      if (!compiled[part]) continue;
      const result = compiled[part].safeParse(req[part] ?? {});
      if (result.success) valid[part] = result.data;
      else issues.push(...result.error.issues.map((i) => ({ location: part, field: i.path.join('.') || undefined, message: i.message })));
    }
    if (issues.length) throw errors.validation(issues);
    req.valid = valid;
    next();
  };
}

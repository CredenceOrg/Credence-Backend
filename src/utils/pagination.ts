// src/utils/pagination.js
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function getPagination(query) {
  // 1. Get page and limit from query, or use defaults
  let page = parseInt(query.page, 10) || 1;
  let limit = parseInt(query.limit, 10) || DEFAULT_LIMIT;

  // 2. Ensure page and limit are positive numbers
  page = page < 1 ? 1 : page;
  limit = limit < 1 ? DEFAULT_LIMIT : limit;

  // 3. Enforce the maximum limit
  if (limit > MAX_LIMIT) {
    limit = MAX_LIMIT;
  }

  // 4. Calculate offset for your database query
  const offset = (page - 1) * limit;

  // 5. Return the pagination object
  return { page, limit, offset };
}

module.exports = { getPagination, DEFAULT_LIMIT, MAX_LIMIT };
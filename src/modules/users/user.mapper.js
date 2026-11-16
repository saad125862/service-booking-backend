// Never expose password_hash. Single place that shapes a user for API responses.
export const toUser = (row) => ({
  id: row.id,
  name: row.name,
  email: row.email,
  phone: row.phone,
  createdAt: row.created_at,
});

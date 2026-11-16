// Never expose passwordHash. Single place that shapes a user for API responses.
export const toUser = (u) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  phone: u.phone,
  createdAt: u.createdAt,
});

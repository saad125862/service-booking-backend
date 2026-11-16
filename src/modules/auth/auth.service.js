import bcrypt from 'bcryptjs';
import { query } from '../../db/pool.js';
import { BCRYPT_COST } from '../../config/constants.js';
import { ApiError } from '../../utils/ApiError.js';
import { signToken } from '../../middleware/auth.js';
import { toUser } from '../users/user.mapper.js';

// Compared against when the email is unknown, so response time doesn't reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_COST);

export async function register({ name, email, password }) {
  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  try {
    const { rows } = await query(
      `INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING *`,
      [name, email, passwordHash],
    );
    return { user: toUser(rows[0]), token: signToken(rows[0].id) };
  } catch (err) {
    if (err.code === '23505') throw ApiError.conflict('EMAIL_TAKEN', 'An account with this email already exists');
    throw err;
  }
}

export async function login({ email, password }) {
  const { rows } = await query(`SELECT * FROM users WHERE email = $1`, [email]);
  const user = rows[0];
  const valid = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !valid) {
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Incorrect email or password');
  }
  return { user: toUser(user), token: signToken(user.id) };
}

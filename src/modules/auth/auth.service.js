import bcrypt from 'bcryptjs';
import { prisma } from '../../db/prisma.js';
import { BCRYPT_COST } from '../../config/constants.js';
import { ApiError } from '../../utils/ApiError.js';
import { signToken } from '../../middleware/auth.js';
import { toUser } from '../users/user.mapper.js';

// Compared against when the email is unknown, so response time doesn't reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_COST);

export async function register({ name, email, password }) {
  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  try {
    const user = await prisma.user.create({ data: { name, email, passwordHash } });
    return { user: toUser(user), token: signToken(user.id) };
  } catch (err) {
    // P2002 = unique constraint violation
    if (err.code === 'P2002') throw ApiError.conflict('EMAIL_TAKEN', 'An account with this email already exists');
    throw err;
  }
}

export async function login({ email, password }) {
  const user = await prisma.user.findUnique({ where: { email } });
  const valid = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !valid) {
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Incorrect email or password');
  }
  return { user: toUser(user), token: signToken(user.id) };
}

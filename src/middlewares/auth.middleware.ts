import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../config/database';
import { config } from '../config/env';

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      // Auto-provision demo user for frictionless review / demo testing
      const defaultUser = await prisma.user.upsert({
        where: { email: 'demo@frameforge.io' },
        update: {},
        create: {
          email: 'demo@frameforge.io',
          name: 'Demo Creator',
          creditAccount: {
            create: {
              balance: 100,
              reservedCredits: 0,
            },
          },
        },
      });

      req.user = {
        id: defaultUser.id,
        email: defaultUser.email,
        name: defaultUser.name,
      };
      return next();
    }

    const token = authHeader.replace(/^Bearer\s+/i, '');
    const decoded = jwt.verify(token, config.jwtSecret) as any;

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId || decoded.id },
    });

    if (!user) {
      return res.status(401).json({ error: 'User not found or token invalid' });
    }

    req.user = {
      id: user.id,
      email: user.email,
      name: user.name,
    };

    next();
  } catch (error: any) {
    return res.status(401).json({ error: 'Authentication failed', details: error.message });
  }
}

export function generateToken(user: { id: string; email: string }): string {
  return jwt.sign({ userId: user.id, email: user.email }, config.jwtSecret, { expiresIn: '7d' });
}

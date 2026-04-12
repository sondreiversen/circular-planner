import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  databaseUrl: process.env.DATABASE_URL || 'postgresql://localhost:5432/circular_planner',
  jwtSecret: process.env.JWT_SECRET || (() => {
    console.warn('[WARNING] JWT_SECRET not set. Using insecure default. Set it in .env!');
    return 'insecure-default-secret-change-me';
  })(),
  nodeEnv: process.env.NODE_ENV || 'development',
};

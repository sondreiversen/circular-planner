import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  httpsPort: parseInt(process.env.HTTPS_PORT || '3443', 10),
  tlsCertFile: process.env.TLS_CERT_FILE,
  tlsKeyFile: process.env.TLS_KEY_FILE,
  forceHttps: process.env.FORCE_HTTPS !== 'false',
  databaseUrl: process.env.DATABASE_URL || 'postgresql://localhost:5432/circular_planner',
  jwtSecret: process.env.JWT_SECRET || (() => {
    console.warn('[WARNING] JWT_SECRET not set. Using insecure default. Set it in .env!');
    return 'insecure-default-secret-change-me';
  })(),
  nodeEnv: process.env.NODE_ENV || 'development',
  gitlab: {
    enabled: process.env.GITLAB_SSO_ENABLED === 'true',
    instanceUrl: process.env.GITLAB_INSTANCE_URL || '',
    clientId: process.env.GITLAB_CLIENT_ID || '',
    clientSecret: process.env.GITLAB_CLIENT_SECRET || '',
    redirectUri: process.env.GITLAB_REDIRECT_URI || '',
    scopes: process.env.GITLAB_SCOPES || 'read_user openid email',
  },
};

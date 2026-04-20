import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  httpsPort: parseInt(process.env.HTTPS_PORT || '3443', 10),
  tlsCertFile: process.env.TLS_CERT_FILE,
  tlsKeyFile: process.env.TLS_KEY_FILE,
  forceHttps: process.env.FORCE_HTTPS !== 'false',
  databaseUrl: process.env.DATABASE_URL || 'postgresql://localhost:5432/circular_planner',
  jwtSecret: (() => {
    const s = process.env.JWT_SECRET;
    if (!s || s.length < 32) {
      console.error(
        'FATAL: JWT_SECRET must be set to a random string of at least 32 characters.\n' +
        '  Remediation: generate one with  openssl rand -hex 32  and set JWT_SECRET in your environment or .env file.'
      );
      process.exit(1);
    }
    return s;
  })(),
  allowedOrigin: process.env.ALLOWED_ORIGIN || 'http://localhost:3000',
  nodeEnv: process.env.NODE_ENV || 'development',
  allowRegistration: process.env.ALLOW_REGISTRATION !== 'false',
  appName: process.env.APP_NAME || 'Circular Planner',
  appLogoUrl: process.env.APP_LOGO_URL || '',
  gitlab: {
    enabled: process.env.GITLAB_SSO_ENABLED === 'true',
    instanceUrl: process.env.GITLAB_INSTANCE_URL || '',
    clientId: process.env.GITLAB_CLIENT_ID || '',
    clientSecret: process.env.GITLAB_CLIENT_SECRET || '',
    redirectUri: process.env.GITLAB_REDIRECT_URI || '',
    scopes: process.env.GITLAB_SCOPES || 'read_user openid email',
  },
};

// --- Post-construction validation ---

if (config.nodeEnv === 'production' && !process.env.ALLOWED_ORIGIN) {
  console.error(
    'FATAL: ALLOWED_ORIGIN must be set in production to prevent open CORS.\n' +
    '  Remediation: set ALLOWED_ORIGIN to your application\'s public URL (e.g. https://planner.example.com).'
  );
  process.exit(1);
}

if (config.gitlab.enabled) {
  const missing = (
    [
      ['GITLAB_INSTANCE_URL', config.gitlab.instanceUrl],
      ['GITLAB_CLIENT_ID', config.gitlab.clientId],
      ['GITLAB_CLIENT_SECRET', config.gitlab.clientSecret],
      ['GITLAB_REDIRECT_URI', config.gitlab.redirectUri],
    ] as [string, string][]
  ).filter(([, v]) => !v).map(([k]) => k);

  if (missing.length > 0) {
    console.error(
      `FATAL: GITLAB_SSO_ENABLED=true but the following required variables are not set: ${missing.join(', ')}.\n` +
      '  Remediation: set all GitLab OAuth2 variables or disable SSO by unsetting GITLAB_SSO_ENABLED.'
    );
    process.exit(1);
  }
}

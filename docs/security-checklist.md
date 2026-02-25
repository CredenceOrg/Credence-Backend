# Security and Hardening Checklist

This document provides a comprehensive security and hardening checklist for deploying the Credence Backend in production environments.

## Table of Contents

- [Environment Variables and Secrets](#environment-variables-and-secrets)
- [Transport Layer Security (TLS)](#transport-layer-security-tls)
- [Cross-Origin Resource Sharing (CORS)](#cross-origin-resource-sharing-cors)
- [Rate Limiting](#rate-limiting)
- [Audit Logging](#audit-logging)
- [Access Control](#access-control)
- [Dependency Security](#dependency-security)
- [Database Security](#database-security)
- [Infrastructure Security](#infrastructure-security)
- [Monitoring and Alerting](#monitoring-and-alerting)
- [Deployment Checklist](#deployment-checklist)

## Environment Variables and Secrets

### Required Environment Variables

| Variable | Description | Security Requirements |
|----------|-------------|----------------------|
| `NODE_ENV` | Environment mode | Set to `production` in production |
| `PORT` | Server port | Use non-standard port if possible |
| `DB_URL` | PostgreSQL connection string | Use SSL connection, strong credentials |
| `REDIS_URL` | Redis connection string | Use TLS, strong credentials |
| `JWT_SECRET` | JWT signing secret | **Minimum 32 characters**, random, high entropy |
| `EVIDENCE_ENCRYPTION_KEY` | AES-256-GCM encryption key | **Exactly 32 characters**, random, high entropy |
| `CORS_ORIGIN` | CORS allowed origins | Restrict to specific domains in production |

### Secret Management Best Practices

1. **Never commit secrets to version control**
   - Ensure `.env` files are in `.gitignore`
   - Use environment-specific configuration files

2. **Use a secret management system**
   - AWS Secrets Manager
   - HashiCorp Vault
   - Azure Key Vault
   - Google Secret Manager

3. **Rotate secrets regularly**
   - JWT secrets: Every 90 days
   - Database credentials: Every 180 days
   - Encryption keys: Annually or if compromised

4. **Generate strong secrets**
   ```bash
   # Generate JWT secret (32+ chars)
   openssl rand -base64 32
   
   # Generate encryption key (exactly 32 chars)
   openssl rand -hex 16
   ```

### Environment Variable Validation

The application uses Zod schema validation for environment variables. Ensure all required variables are set before deployment:

```bash
# Test configuration locally
npm run build
NODE_ENV=production node dist/index.js
```

## Transport Layer Security (TLS)

### TLS Configuration

1. **Use HTTPS everywhere**
   - Obtain SSL/TLS certificates from trusted CA
   - Use Let's Encrypt for free certificates
   - Consider wildcard certificates for multiple subdomains

2. **TLS Version and Ciphers**
   - Enable TLS 1.2 and 1.3 only
   - Disable SSLv2, SSLv3, TLS 1.0, TLS 1.1
   - Use strong cipher suites (AES-256-GCM, ChaCha20-Poly1305)

3. **Certificate Management**
   - Set up automatic certificate renewal
   - Monitor certificate expiration (30 days before expiry)
   - Use Certificate Authority Authorization (CAA) DNS records

### Reverse Proxy TLS Configuration

**Nginx Example:**
```nginx
server {
    listen 443 ssl http2;
    server_name api.credence.com;
    
    ssl_certificate /etc/letsencrypt/live/api.credence.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.credence.com/privkey.pem;
    
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-RSA-AES256-GCM-SHA512:DHE-RSA-AES256-GCM-SHA512;
    ssl_prefer_server_ciphers off;
    
    add_header Strict-Transport-Security "max-age=63072000" always;
    
    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

## Cross-Origin Resource Sharing (CORS)

### CORS Security Configuration

1. **Restrict origins in production**
   ```env
   CORS_ORIGIN=https://app.credence.com,https://admin.credence.com
   ```

2. **Avoid wildcard origins**
   - Never use `CORS_ORIGIN=*` in production
   - Specify exact domains that need access

3. **Implement CORS headers properly**
   - `Access-Control-Allow-Origin`: Specific domains only
   - `Access-Control-Allow-Methods`: Limit to required methods
   - `Access-Control-Allow-Headers`: Limit to required headers
   - `Access-Control-Max-Age`: Set reasonable cache time

### CORS Middleware Implementation

```typescript
// Example secure CORS configuration
app.use(cors({
  origin: process.env.CORS_ORIGIN?.split(',') || [],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  maxAge: 86400, // 24 hours
}));
```

## Rate Limiting

### Rate Limiting Strategy

1. **Implement multiple rate limiting layers**
   - IP-based rate limiting
   - User-based rate limiting (when authenticated)
   - API key-based rate limiting

2. **Recommended rate limits**
   - Public endpoints: 100 requests/minute/IP
   - Authenticated endpoints: 1000 requests/minute/user
   - API endpoints: 10,000 requests/minute/api-key
   - Bulk operations: 10 requests/minute/api-key

3. **Rate limiting implementation**
   ```typescript
   // Example using express-rate-limit
   import rateLimit from 'express-rate-limit';
   
   const publicLimiter = rateLimit({
     windowMs: 60 * 1000, // 1 minute
     max: 100, // 100 requests per minute
     message: 'Too many requests',
     standardHeaders: true,
     legacyHeaders: false,
   });
   
   app.use('/api/', publicLimiter);
   ```

### Advanced Rate Limiting

1. **Use Redis for distributed rate limiting**
   - Ensures consistency across multiple instances
   - Provides persistence and scalability

2. **Implement progressive backoff**
   - Increase penalty for repeated violations
   - Implement exponential backoff for abusive clients

3. **Rate limit by endpoint type**
   - Stricter limits for sensitive operations
   - Higher limits for read-only operations

## Audit Logging

### Required Audit Events

1. **Authentication events**
   - Login attempts (success/failure)
   - Token generation and refresh
   - Password changes
   - Account lockouts

2. **Authorization events**
   - Access to protected resources
   - Permission changes
   - Role assignments

3. **Data operations**
   - Create, read, update, delete operations
   - Bulk operations
   - Data exports

4. **Security events**
   - Failed authentication attempts
   - Rate limit violations
   - Suspicious activity patterns

### Audit Log Format

```typescript
interface AuditLog {
  timestamp: string;
  level: 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL';
  event: string;
  userId?: string;
  apiKey?: string;
  ip: string;
  userAgent: string;
  resource: string;
  action: string;
  result: 'SUCCESS' | 'FAILURE';
  details?: Record<string, any>;
}
```

### Logging Implementation

1. **Structured logging**
   - Use JSON format for machine readability
   - Include correlation IDs for request tracing

2. **Log retention**
   - Keep audit logs for minimum 1 year
   - Use immutable storage (WORM)
   - Implement log rotation and archival

3. **Log security**
   - Encrypt sensitive log data
   - Restrict log access to authorized personnel
   - Implement log integrity verification

## Access Control

### Role-Based Access Control (RBAC)

The application implements RBAC with the following roles:

| Role | Permissions | Use Case |
|------|-------------|----------|
| `USER` | Basic read operations | Standard users |
| `ARBITRATOR` | Access to encrypted evidence | Dispute resolution |
| `GOVERNANCE` | Full system access | Platform management |

### Access Control Implementation

1. **API Key Authentication**
   - Implement API key rotation
   - Use different scopes for different operations
   - Monitor API key usage

2. **JWT Token Security**
   - Use short expiration times (1 hour)
   - Implement refresh tokens
   - Use secure token storage

3. **Permission Validation**
   ```typescript
   // Example permission check
   const requirePermission = (permission: string) => {
     return (req: Request, res: Response, next: NextFunction) => {
       if (!req.user?.permissions.includes(permission)) {
         return res.status(403).json({ error: 'Insufficient permissions' });
       }
       next();
     };
   };
   ```

### Security Headers

Implement security headers for all responses:

```typescript
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
}));
```

## Dependency Security

### Dependency Scanning

1. **Automated dependency scanning**
   ```bash
   # npm audit (built-in)
   npm audit --audit-level moderate
   
   # Snyk (recommended)
   npx snyk test
   
   # OWASP Dependency Check
   dependency-check .
   ```

2. **Continuous monitoring**
   - Set up automated security scanning in CI/CD
   - Configure alerts for new vulnerabilities
   - Implement automated dependency updates

3. **Vulnerability management**
   - Prioritize critical and high-severity vulnerabilities
   - Maintain a vulnerability inventory
   - Document risk acceptance decisions

### Package Security

1. **Use package-lock.json**
   - Ensures reproducible builds
   - Prevents dependency confusion attacks

2. **Verify package integrity**
   ```bash
   # Verify npm package integrity
   npm ci --prefer-offline --no-audit
   ```

3. **Minimize attack surface**
   - Remove unused dependencies
   - Use specific package versions (not ranges)
   - Regularly review third-party packages

### Security Updates

1. **Update strategy**
   - Subscribe to security advisories
   - Test updates in staging environment
   - Schedule regular update windows

2. **Emergency patching**
   - Maintain rollback procedures
   - Document emergency patch process
   - Test critical security patches immediately

## Database Security

### PostgreSQL Security

1. **Connection security**
   - Use SSL/TLS for database connections
   - Implement connection pooling
   - Use database-specific users with minimal privileges

2. **Data encryption**
   - Enable transparent data encryption (TDE)
   - Encrypt sensitive columns
   - Use application-level encryption for PII

3. **Access control**
   ```sql
   -- Create application-specific user
   CREATE USER credence_app WITH PASSWORD 'strong_password';
   GRANT CONNECT ON DATABASE credence TO credence_app;
   GRANT USAGE ON SCHEMA public TO credence_app;
   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO credence_app;
   ```

### Redis Security

1. **Network security**
   - Bind Redis to localhost or private network
   - Use Redis AUTH or ACL system
   - Implement Redis over TLS

2. **Data protection**
   - Enable Redis persistence with encryption
   - Regularly backup Redis data
   - Monitor Redis memory usage

### Database Hardening

1. **Remove default accounts**
2. **Disable unused database features**
3. **Implement database auditing**
4. **Regular security assessments**

## Infrastructure Security

### Container Security

1. **Docker security**
   ```dockerfile
   # Use minimal base image
   FROM node:18-alpine
   
   # Create non-root user
   RUN addgroup -g 1001 -S nodejs
   RUN adduser -S nodejs -u 1001
   
   # Set proper permissions
   USER nodejs
   
   # Health check
   HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
     CMD curl -f http://localhost:3000/api/health || exit 1
   ```

2. **Container runtime security**
   - Use read-only filesystems where possible
   - Implement resource limits
   - Use security profiles (AppArmor, SELinux)

### Network Security

1. **Network segmentation**
   - Separate application, database, and cache networks
   - Implement network firewalls
   - Use private subnets for sensitive services

2. **Ingress security**
   - Use Web Application Firewall (WAF)
   - Implement DDoS protection
   - Configure proper load balancing

### Cloud Security

1. **Identity and Access Management**
   - Use principle of least privilege
   - Implement MFA for all accounts
   - Regular access reviews

2. **Cloud-specific security**
   - Enable security monitoring and logging
   - Use cloud security services (AWS GuardDuty, Azure Security Center)
   - Implement proper resource tagging

## Monitoring and Alerting

### Security Monitoring

1. **Key metrics to monitor**
   - Failed authentication attempts
   - Unusual API usage patterns
   - Rate limit violations
   - Error rates and types

2. **Alert configuration**
   - Immediate alerts for critical security events
   - Daily summaries for lower-priority events
   - Escalation procedures for security incidents

### Log Monitoring

1. **Centralized logging**
   - Use ELK Stack, Splunk, or cloud logging services
   - Implement log aggregation and correlation
   - Set up automated log analysis

2. **Security log analysis**
   - Monitor for suspicious patterns
   - Implement baseline behavior analysis
   - Use machine learning for anomaly detection

### Performance Monitoring

1. **Application performance monitoring (APM)**
   - Monitor response times and error rates
   - Track resource utilization
   - Implement distributed tracing

2. **Infrastructure monitoring**
   - CPU, memory, and disk usage
   - Network latency and throughput
   - Database performance metrics

## Deployment Checklist

### Pre-Deployment Checklist

- [ ] **Environment Variables**
  - [ ] All required environment variables are set
  - [ ] Secrets are properly managed and not in code
  - [ ] JWT_SECRET is at least 32 characters
  - [ ] EVIDENCE_ENCRYPTION_KEY is exactly 32 characters
  - [ ] CORS_ORIGIN is restricted to specific domains

- [ ] **TLS Configuration**
  - [ ] SSL/TLS certificates are installed and valid
  - [ ] HTTPS is enforced for all endpoints
  - [ ] HSTS headers are configured
  - [ ] Certificate auto-renewal is set up

- [ ] **Database Security**
  - [ ] Database connections use SSL/TLS
  - [ ] Database users have minimal privileges
  - [ ] Sensitive data is encrypted at rest
  - [ ] Database backups are encrypted

- [ ] **Application Security**
  - [ ] Rate limiting is configured
  - [ ] Security headers are implemented
  - [ ] Input validation is enabled
  - [ ] Error messages don't leak sensitive information

- [ ] **Dependency Security**
  - [ ] `npm audit` shows no critical vulnerabilities
  - [ ] Dependencies are scanned with Snyk or similar tool
  - [ ] Package-lock.json is used and committed
  - [ ] Unused dependencies are removed

- [ ] **Monitoring and Logging**
  - [ ] Audit logging is configured
  - [ ] Log aggregation is set up
  - [ ] Security monitoring is enabled
  - [ ] Alerting is configured for security events

### Post-Deployment Checklist

- [ ] **Security Testing**
  - [ ] Penetration testing completed
  - [ ] Vulnerability scanning performed
  - [ ] Security headers verified
  - [ ] TLS configuration tested

- [ ] **Operational Readiness**
  - [ ] Backup procedures tested
  - [ ] Incident response plan documented
  - [ ] Team trained on security procedures
  - [ ] Documentation is up to date

- [ ] **Compliance**
  - [ ] Data protection requirements met
  - [ ] Audit trails are complete
  - [ ] Retention policies are implemented
  - [ ] Privacy requirements are satisfied

### Ongoing Security Tasks

- [ ] **Regular Security Reviews**
  - [ ] Monthly dependency scans
  - [ ] Quarterly security assessments
  - [ ] Annual penetration testing
  - [ ] Bi-annual access reviews

- [ ] **Maintenance**
  - [ ] Regular security updates
  - [ ] Log rotation and archival
  - [ ] Certificate renewal
  - [ ] Secret rotation

## References and Resources

### Security Standards
- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [NIST Cybersecurity Framework](https://www.nist.gov/cyberframework)
- [ISO 27001](https://www.iso.org/isoiec-27001-information-security.html)

### Tools and Services
- [Snyk](https://snyk.io/) - Dependency scanning
- [OWASP ZAP](https://www.zaproxy.org/) - Security testing
- [Let's Encrypt](https://letsencrypt.org/) - Free SSL certificates
- [HashiCorp Vault](https://www.vaultproject.io/) - Secret management

### Documentation
- [Express.js Security Best Practices](https://expressjs.com/en/advanced/security-best-practices.html)
- [Node.js Security Checklist](https://github.com/lirantal/nodejs-security-checklist)
- [PostgreSQL Security Documentation](https://www.postgresql.org/docs/current/security.html)

---

**Last Updated**: 2025-02-25  
**Version**: 1.0  
**Review Frequency**: Quarterly  

For questions or concerns about this security checklist, please contact the security team or create an issue in the repository.

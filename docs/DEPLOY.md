# Environment-Specific Deployment Guide

This document outlines the step-by-step deployment procedures for the Credence Backend across our environments (Development, Staging, and Production). It is intended to guide operators in bringing up, upgrading, and rolling back the application safely.

**Audience:** Operators (Release Engineers, Systems Administrators, and On-Call Engineers)  
**Last Updated:** 2026-07-26

---

## 1. Environment Classification

| Environment | Purpose | Infrastructure | Deploy Trigger | Data Persistence |
|---|---|---|---|---|
| **Development** | Local iteration, testing, and debugging | Docker Compose / Local Node.js | Manual run/restart | Local volumes (volatile) |
| **Staging** | Pre-production testing, performance validation, and QA | Kubernetes (`credence-staging` namespace) | Automated CI/CD (GitHub Actions) | Dedicated staging DB and Redis |
| **Production** | Live tenant traffic | Kubernetes (`credence` namespace) | Manual approval / Operator-run script | Production multi-replica DB + failover replication |

---

## 2. Development Environment Setup

Local development mimics production dependencies using local containers for PostgreSQL and Redis.

### Prerequisites
- Node.js 18+
- Docker & Docker Compose
- `npm` package manager

### Deployment Steps

1. **Clone and Install Dependencies:**
   ```bash
   git clone https://github.com/CredenceOrg/Credence-Backend.git
   cd Credence-Backend
   npm install
   ```

2. **Configure Local Environment:**
   Copy the example environment template to `.env`. Do not commit this file:
   ```bash
   cp .env.example .env
   ```
   *Note: Ensure the development values inside `.env` match your local port setup.*

3. **Start Core Dependencies:**
   Bring up PostgreSQL and Redis in the background:
   ```bash
   docker compose up -d postgres redis
   ```

4. **Run Database Migrations:**
   Compile the TypeScript migrations and run them against your local database:
   ```bash
   npm run migrate:dev
   ```

5. **Start the Application:**
   Run the development server in watch mode:
   ```bash
   npm run dev
   ```

6. **Verify Service Health:**
   Check the liveness health endpoint. It should return a 200 OK:
   ```bash
   curl -s http://localhost:3000/api/health/live
   ```
   **Expected Response:**
   ```json
   {
     "status": "ok",
     "service": "credence-backend"
   }
   ```

---

## 3. Staging Environment Deployment

Staging is running in Kubernetes and uses the `credence-staging` namespace. It runs a single-replica PostgreSQL and Redis cluster to test changes before production.

### Prerequisites
- Container image built and pushed to the registry
- Access to the target Kubernetes cluster with `kubectl` context pointed to the staging namespace

### Deployment Steps

1. **Build and Tag Container Image:**
   In CI or your build machine, build the image tagged with the Git SHA:
   ```bash
   docker build -t ghcr.io/credenceorg/credence-backend:d3a8f10 .
   docker push ghcr.io/credenceorg/credence-backend:d3a8f10
   ```

2. **Verify Target Context:**
   Ensure `kubectl` is configured and pointing to the staging environment:
   ```bash
   kubectl config current-context
   # Expected output should contain: staging-cluster-context
   ```

3. **Apply Database Migrations:**
   Run migrations prior to updating the image:
   ```bash
   export DATABASE_URL="postgresql://credence_user:staging_password@staging-db.internal:5432/credence_staging"
   npm run migrate
   ```

4. **Update Deployments in Kubernetes:**
   Apply changes by rolling out the new container image to the staging namespace:
   ```bash
   kubectl set image deployment/credence-backend \
     credence-backend=ghcr.io/credenceorg/credence-backend:d3a8f10 \
     -n credence-staging
   ```

5. **Monitor Rollout Status:**
   ```bash
   kubectl rollout status deployment/credence-backend -n credence-staging --timeout=120s
   ```

6. **Validate Readiness:**
   Port-forward the service to verify the dependency health check status:
   ```bash
   kubectl port-forward svc/credence-backend 8080:80 -n credence-staging &
   curl -s http://localhost:8080/api/health | jq .
   ```
   **Expected Response:**
   ```json
   {
     "status": "ok",
     "service": "credence-backend",
     "dependencies": {
       "postgres": { "status": "up", "latencyMs": 5 },
       "redis": { "status": "up", "latencyMs": 2 },
       "horizonListener": { "status": "up", "lagSeconds": 0 }
     }
   }
   ```

---

## 4. Production Environment Deployment

Production runs in the `credence` namespace with dual replicas, resource constraints, and health gates defined in `k8s/deployment.yaml`.

### Prerequisites
- Build has been validated in the staging environment.
- Configured access to the production Kubernetes cluster with `kubectl`.
- Release note changes documented, including database migrations.

### Deployment Steps

1. **Record Rollback Anchor:**
   Capture the current rollout revision number in case an immediate rollback is needed:
   ```bash
   kubectl rollout history deployment/credence-backend -n credence
   ```

2. **Preflight Migration Checks:**
   Verify migration safety constraints and execute a dry-run check:
   ```bash
   npm run migrate:safety
   npm run migrate:preflight
   npm run migrate:dry-run
   ```

3. **Apply Database Migrations:**
   Run migrations against the production database:
   ```bash
   export DATABASE_URL="postgresql://credence_prod:secure_prod_password@prod-db.internal:5432/credence_production"
   npm run migrate
   ```

4. **Annotate Rollout Intent:**
   Set the change cause so history logs are readable:
   ```bash
   kubectl annotate deployment/credence-backend -n credence \
     kubernetes.io/change-cause="deploy git-d3a8f10" --overwrite
   ```

5. **Deploy the Production Container Image:**
   Trigger the rolling update:
   ```bash
   kubectl set image deployment/credence-backend \
     credence-backend=ghcr.io/credenceorg/credence-backend:d3a8f10 \
     -n credence
   ```

6. **Monitor Rollout Progress:**
   Watch the rolling update status:
   ```bash
   kubectl rollout status deployment/credence-backend -n credence --timeout=180s
   ```

7. **Verify Service Health & Traffic:**
   Ensure the new pods are correctly answering requests:
   ```bash
   kubectl get pods -n credence -l app.kubernetes.io/name=credence-backend
   # Check logs of the active pods
   kubectl logs -f deployment/credence-backend -c backend -n credence --tail=100
   ```

---

## 5. Rollback Procedures

If validation fails, execute a rollback to restore service health immediately.

### Kubernetes Reversion
Roll back the deployment to the previous revision:
```bash
kubectl rollout undo deployment/credence-backend -n credence
```
To roll back to a specific revision number (e.g., revision 12):
```bash
kubectl rollout undo deployment/credence-backend -n credence --to-revision=12
```

### Database Migration Rollback (If Required)
If the deployment rollback requires restoring a database schema change:
```bash
# Run migrate:down to rollback the last applied migration step
export DATABASE_URL="postgresql://credence_user:password@db.internal:5432/credence"
npm run migrate:down
```
*Caution: Migration rollbacks can be destructive if column/table deletions are involved. Always verify backup snapshots beforehand.*

---

## 6. Related Documentation

- [docs/k8s.md](k8s.md) - Full manifest configurations and first-time cluster setup
- [docs/deployment-cutover.md](deployment-cutover.md) - In-depth health check criteria and rolling update mechanics
- [docs/RUNBOOK.md](RUNBOOK.md) - Diagnostic guides for database, Redis, and connectivity failures

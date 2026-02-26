#!/bin/bash

# Verification script for Grafana monitoring setup
# Run this to verify all monitoring files are in place

set -e

echo "🔍 Verifying Credence Backend Monitoring Setup..."
echo ""

# Color codes
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check function
check_file() {
    if [ -f "$1" ]; then
        echo -e "${GREEN}✓${NC} $1"
        return 0
    else
        echo -e "${RED}✗${NC} $1 (MISSING)"
        return 1
    fi
}

check_dir() {
    if [ -d "$1" ]; then
        echo -e "${GREEN}✓${NC} $1/"
        return 0
    else
        echo -e "${RED}✗${NC} $1/ (MISSING)"
        return 1
    fi
}

ERRORS=0

echo "📁 Checking directory structure..."
check_dir "monitoring" || ((ERRORS++))
check_dir "monitoring/grafana" || ((ERRORS++))
check_dir "monitoring/grafana/provisioning" || ((ERRORS++))
check_dir "monitoring/grafana/provisioning/dashboards" || ((ERRORS++))
check_dir "monitoring/grafana/provisioning/datasources" || ((ERRORS++))
check_dir "monitoring/prometheus" || ((ERRORS++))
echo ""

echo "📄 Checking configuration files..."
check_file "monitoring/grafana/dashboard.json" || ((ERRORS++))
check_file "monitoring/grafana/provisioning/dashboards/dashboard.yml" || ((ERRORS++))
check_file "monitoring/grafana/provisioning/datasources/prometheus.yml" || ((ERRORS++))
check_file "monitoring/prometheus/prometheus.yml" || ((ERRORS++))
check_file "monitoring/prometheus/alerts.yml" || ((ERRORS++))
check_file "docker-compose.yml" || ((ERRORS++))
echo ""

echo "📚 Checking documentation..."
check_file "docs/monitoring.md" || ((ERRORS++))
check_file "monitoring/README.md" || ((ERRORS++))
check_file "monitoring/DASHBOARD_SCREENSHOTS.md" || ((ERRORS++))
check_file "MONITORING_QUICKSTART.md" || ((ERRORS++))
check_file "GRAFANA_DASHBOARD_IMPLEMENTATION.md" || ((ERRORS++))
echo ""

echo "🔧 Checking example implementation..."
check_file "src/middleware/metrics.example.ts" || ((ERRORS++))
echo ""

echo "📊 Validating dashboard JSON..."
if command -v jq &> /dev/null; then
    if jq empty monitoring/grafana/dashboard.json 2>/dev/null; then
        echo -e "${GREEN}✓${NC} Dashboard JSON is valid"
    else
        echo -e "${RED}✗${NC} Dashboard JSON is invalid"
        ((ERRORS++))
    fi
else
    echo -e "${YELLOW}⚠${NC} jq not installed, skipping JSON validation"
fi
echo ""

echo "🐳 Checking Docker Compose configuration..."
if command -v docker-compose &> /dev/null; then
    if docker-compose config > /dev/null 2>&1; then
        echo -e "${GREEN}✓${NC} Docker Compose configuration is valid"
    else
        echo -e "${RED}✗${NC} Docker Compose configuration is invalid"
        ((ERRORS++))
    fi
else
    echo -e "${YELLOW}⚠${NC} docker-compose not installed, skipping validation"
fi
echo ""

echo "📦 Checking dependencies..."
if [ -f "package.json" ]; then
    if grep -q "prom-client" package.json; then
        echo -e "${GREEN}✓${NC} prom-client is in package.json"
    else
        echo -e "${YELLOW}⚠${NC} prom-client not in package.json (run: npm install prom-client)"
    fi
else
    echo -e "${RED}✗${NC} package.json not found"
    ((ERRORS++))
fi
echo ""

# Summary
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ $ERRORS -eq 0 ]; then
    echo -e "${GREEN}✓ All checks passed!${NC}"
    echo ""
    echo "Next steps:"
    echo "1. Install prom-client: npm install prom-client"
    echo "2. Copy metrics file: cp src/middleware/metrics.example.ts src/middleware/metrics.ts"
    echo "3. Update src/index.ts to include metrics (see docs/monitoring.md)"
    echo "4. Start monitoring stack: docker-compose up -d"
    echo "5. Access Grafana: http://localhost:3001 (admin/admin)"
    echo ""
    echo "📖 Read MONITORING_QUICKSTART.md for detailed setup instructions"
    exit 0
else
    echo -e "${RED}✗ Found $ERRORS error(s)${NC}"
    echo ""
    echo "Please fix the missing files and try again."
    exit 1
fi

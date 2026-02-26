# Grafana Dashboard Screenshots and Descriptions

This document describes what the Credence Backend Grafana dashboard looks like when deployed. Use these descriptions to verify your setup or create documentation.

## Dashboard Overview

**Title**: Credence Backend - API Monitoring  
**UID**: credence-backend-dashboard  
**Tags**: credence, backend, api  
**Refresh**: 10s auto-refresh  
**Time Range**: Last 1 hour (default)

---

## Panel Layout

### Row 1: HTTP Overview (Y: 0-8)

#### Panel 1: HTTP Error Rate (5xx) - Gauge
**Position**: X: 0-6, Y: 0-8  
**Type**: Gauge  
**Description**: Shows the percentage of 5xx errors out of total requests

**Visual Appearance**:
- Large circular gauge
- Green zone: 0-5% (healthy)
- Red zone: >5% (critical)
- Current value displayed in center
- Percentage format

**What to Look For**:
- Should normally show 0% or very low percentage
- Spikes indicate server errors
- Sustained high values require immediate attention

---

#### Panel 2: HTTP Request Rate - Time Series
**Position**: X: 6-15, Y: 0-8  
**Type**: Time series graph  
**Description**: Shows requests per second over time, broken down by method, route, and status

**Visual Appearance**:
- Multi-line graph with different colors per endpoint
- Y-axis: Requests per second
- X-axis: Time
- Legend shows: GET /api/health - 200, POST /api/bulk/verify - 200, etc.

**What to Look For**:
- Traffic patterns and peaks
- Endpoint usage distribution
- Sudden drops (potential outage)
- Unusual spikes (potential attack or load)

---

#### Panel 3: HTTP Request Latency (p50, p95) - Time Series
**Position**: X: 15-24, Y: 0-8  
**Type**: Time series graph  
**Description**: Shows 50th and 95th percentile latencies

**Visual Appearance**:
- Two lines: p50 (median) and p95
- Y-axis: Seconds
- Color coding: Green (<0.5s), Yellow (0.5-1s), Red (>1s)
- Legend shows mean and max values

**What to Look For**:
- p50 should be consistently low (<100ms for most endpoints)
- p95 shows worst-case user experience
- Growing gap between p50 and p95 indicates inconsistent performance
- Spikes correlate with load or issues

---

### Row 2: Status Codes and Health (Y: 8-16)

#### Panel 4: HTTP Status Codes Distribution - Time Series (Stacked)
**Position**: X: 0-12, Y: 8-16  
**Type**: Stacked time series  
**Description**: Shows distribution of HTTP status codes over time

**Visual Appearance**:
- Stacked area chart
- Different colors for status code ranges:
  - Green: 2xx (success)
  - Blue: 3xx (redirect)
  - Yellow: 4xx (client error)
  - Red: 5xx (server error)
- Y-axis: Requests per second
- Legend shows total count per status

**What to Look For**:
- Mostly green (2xx) is healthy
- Yellow (4xx) indicates client issues or validation errors
- Red (5xx) requires immediate investigation
- Patterns in error codes

---

#### Panel 5: Database Health - Gauge
**Position**: X: 12-18, Y: 8-16  
**Type**: Gauge  
**Description**: Real-time database connectivity status

**Visual Appearance**:
- Circular gauge with binary status
- Green: "Up" (value: 1)
- Red: "Down" (value: 0)
- Large, easy-to-read status indicator

**What to Look For**:
- Should always show "Up" (green)
- "Down" (red) indicates database connectivity issues
- Check database logs if down

---

#### Panel 6: Redis Health - Gauge
**Position**: X: 18-24, Y: 8-16  
**Type**: Gauge  
**Description**: Real-time Redis connectivity status

**Visual Appearance**:
- Circular gauge with binary status
- Green: "Up" (value: 1)
- Red: "Down" (value: 0)
- Large, easy-to-read status indicator

**What to Look For**:
- Should always show "Up" (green)
- "Down" (red) indicates Redis connectivity issues
- Check Redis logs if down

---

### Row 3: Health Check Performance (Y: 16-24)

#### Panel 7: Health Check Duration - Time Series
**Position**: X: 0-12, Y: 16-24  
**Type**: Time series graph  
**Description**: Shows how long health checks take

**Visual Appearance**:
- Two lines: DB check duration, Redis check duration
- Y-axis: Seconds
- Thresholds: Yellow (>3s), Red (>5s)
- Legend shows mean and max values

**What to Look For**:
- Should be consistently low (<1s)
- Spikes indicate slow database/Redis responses
- Sustained high values indicate performance issues
- Timeout is 5 seconds

---

#### Panel 8: Business Metrics - Operations Rate - Time Series
**Position**: X: 12-24, Y: 16-24  
**Type**: Time series graph  
**Description**: Shows rate of business operations

**Visual Appearance**:
- Three lines:
  - Reputation Calculations (blue)
  - Identity Verifications (green)
  - Bulk Verifications (orange)
- Y-axis: Operations per second
- Legend shows sum of operations

**What to Look For**:
- Business activity patterns
- Peak usage times
- Correlation between different operations
- Drops indicate reduced usage or issues

---

### Row 4: Business Operations Performance (Y: 24-32)

#### Panel 9: Business Operations Duration (p95) - Time Series
**Position**: X: 0-12, Y: 24-32  
**Type**: Time series graph  
**Description**: Shows 95th percentile duration for business operations

**Visual Appearance**:
- Two lines:
  - p95 Reputation Calculation (blue)
  - p95 Identity Sync (green)
- Y-axis: Seconds
- Thresholds: Yellow (>2s), Red (>5s)
- Legend shows mean and max

**What to Look For**:
- Reputation calculations should be fast (<100ms)
- Identity sync can be slower (1-2s acceptable)
- Spikes indicate performance degradation
- Sustained high values need optimization

---

#### Panel 10: Avg Bulk Verification Batch Size - Gauge
**Position**: X: 12-18, Y: 24-32  
**Type**: Gauge  
**Description**: Average number of addresses per bulk verification request

**Visual Appearance**:
- Circular gauge
- Green: 0-50 (normal)
- Yellow: 50-80 (high)
- Red: 80-100 (at limit)
- Shows numeric value

**What to Look For**:
- Typical values: 10-50
- High values (>80) indicate users hitting limits
- Low values (<5) suggest inefficient API usage
- Max is 100 per API design

---

#### Panel 11: Total Verifications (24h) - Stat
**Position**: X: 18-24, Y: 24-32  
**Type**: Stat panel  
**Description**: Total identity verifications in last 24 hours

**Visual Appearance**:
- Large number display
- Area graph in background showing trend
- Color changes based on value
- Auto-formatted (1.2K, 15.3K, etc.)

**What to Look For**:
- Daily volume trends
- Growth over time
- Drops indicate reduced usage
- Use for capacity planning

---

## Dashboard Features

### Top Bar Controls

**Time Range Picker** (Top Right)
- Quick ranges: Last 5m, 15m, 1h, 6h, 24h, 7d, 30d
- Custom range selector
- Refresh interval: 10s, 30s, 1m, 5m, off

**Refresh Button**
- Manual refresh
- Auto-refresh indicator

**Dashboard Settings** (Gear Icon)
- General settings
- Variables
- JSON model export
- Save dashboard

### Variables

**DS_PROMETHEUS** (Top Left)
- Datasource selector
- Defaults to "Prometheus"
- Can switch between multiple Prometheus instances

### Annotations

- Deployment markers (if configured)
- Alert annotations
- Custom event markers

---

## Color Scheme

The dashboard uses a dark theme with:
- **Green**: Healthy, success, 2xx responses
- **Yellow**: Warning, degraded, 4xx responses
- **Red**: Critical, error, 5xx responses
- **Blue**: Information, metrics
- **Orange**: Business metrics

---

## Typical Healthy Dashboard

When everything is working correctly:

1. **Error Rate**: 0% or <1%
2. **Request Rate**: Steady traffic pattern
3. **Latency**: p50 <100ms, p95 <500ms
4. **Status Codes**: Mostly green (2xx)
5. **DB Health**: Green "Up"
6. **Redis Health**: Green "Up"
7. **Health Check Duration**: <1s
8. **Business Operations**: Steady rate
9. **Operation Duration**: Low and consistent
10. **Batch Size**: 10-50 average
11. **Total Verifications**: Growing trend

---

## Alert Indicators

When alerts fire, you'll see:
- Red borders on affected panels
- Alert annotations on time series
- Alert state in Prometheus UI
- Notifications (if configured)

---

## Mobile View

The dashboard is responsive and works on mobile:
- Panels stack vertically
- Gauges remain readable
- Time series graphs adapt
- Touch-friendly controls

---

## Exporting

To export the dashboard:
1. Click Dashboard Settings (gear icon)
2. Select "JSON Model"
3. Copy JSON or download
4. Save to version control

---

## Customization Tips

### Adding Panels
1. Click "Add panel" (top right)
2. Select visualization type
3. Configure query
4. Set thresholds and styling
5. Save dashboard

### Modifying Queries
1. Edit panel
2. Update PromQL query
3. Test with "Query inspector"
4. Apply changes

### Changing Thresholds
1. Edit panel
2. Go to "Thresholds" section
3. Adjust values and colors
4. Preview changes

---

## Troubleshooting Dashboard Issues

### No Data Showing
- Check time range (top right)
- Verify Prometheus datasource is connected
- Ensure backend is running and exposing /metrics
- Check Prometheus targets are UP

### Panels Show "N/A"
- Metric not being collected
- Check metric name in query
- Verify instrumentation is active
- Generate test traffic

### Slow Loading
- Reduce time range
- Optimize queries
- Check Prometheus performance
- Consider recording rules

---

## Best Practices

1. **Monitor regularly**: Check dashboard daily
2. **Set up alerts**: Don't rely on manual checking
3. **Customize for your needs**: Add relevant panels
4. **Document changes**: Keep dashboard in version control
5. **Share with team**: Export and distribute
6. **Review metrics**: Ensure they're meaningful
7. **Optimize queries**: Keep dashboard responsive

---

## Screenshots Checklist

When creating actual screenshots for documentation:

- [ ] Full dashboard overview
- [ ] HTTP error rate gauge (healthy state)
- [ ] HTTP error rate gauge (alert state)
- [ ] Request rate time series with traffic
- [ ] Latency graph showing p50 and p95
- [ ] Status code distribution (healthy)
- [ ] Database health (up)
- [ ] Redis health (up)
- [ ] Health check duration graph
- [ ] Business operations rate
- [ ] Operation duration graph
- [ ] Batch size gauge
- [ ] Total verifications stat
- [ ] Dashboard settings menu
- [ ] Time range picker
- [ ] Panel edit mode
- [ ] Query inspector
- [ ] Mobile view

---

**Note**: This document describes the visual appearance of the dashboard. For actual screenshots, deploy the monitoring stack and capture images of each panel in various states (healthy, warning, critical).

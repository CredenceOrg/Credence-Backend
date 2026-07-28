import { Router, Request, Response } from "express";
import { requireApiKey, ApiScope } from "../middleware/auth.js";
import { ReportService } from "../services/reportService.js";
import { ReportRepository } from "../db/repositories/reportRepository.js";
import { ReportStorageService } from "../services/reportStorage.js";
import { pool } from "../db/pool.js";
import { validate, type ValidatedRequest } from "../middleware/validate.js";
import {
  createReportBodySchema,
  reportJobParamsSchema,
  topTalkersQuerySchema,
  type CreateReportBody,
  type ReportJobParams,
} from "../schemas/report.js";
import { auditLogService } from "../services/audit/index.js";
import { sendError, ErrorCode } from "../lib/errors.js";

const router = Router();
const reportRepository = new ReportRepository(pool);
const reportStorage = new ReportStorageService();
const reportService = new ReportService(reportRepository, reportStorage);

/**
 * GET /api/reports/top-talkers
 *
 * Returns Top N tenants by request count in the aggregate window (default: last hour).
 *
 * @requires enterprise scope
 */
router.get(
  "/top-talkers",
  requireApiKey(ApiScope.ENTERPRISE),
  validate({ query: topTalkersQuerySchema }),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { limit, windowMinutes } = (req.query as unknown) as {
        limit?: number;
        windowMinutes?: number;
      };

      const report = await auditLogService.getTopTalkers(limit, windowMinutes);

      res.status(200).json({
        success: true,
        data: report,
      });
    } catch (error) {
      console.error("Top talkers report error:", error);
      sendError(res, ErrorCode.INTERNAL_SERVER_ERROR, "An unexpected error occurred while fetching top talkers report");
    }
  },
);


/**
 * POST /api/reports
 *
 * Starts an asynchronous report generation job
 *
 * @requires reports:generate scope
 *
 * @body {string} type - Type of report to generate (e.g., 'trust_score_summary')
 *
 * @returns {object} Job information with status 'queued'
 */
router.post(
  "/",
  requireApiKey(ApiScope.ENTERPRISE),
  validate({ body: createReportBodySchema }),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { type } = req.validated!.body! as CreateReportBody;

      const tenantId = (req as any).apiKey?.tenantId ?? "default";
      // Extract additional params from body for deduplication
      const params = { ...req.validated!.body };
      delete (params as any).type;

      try {
        const job = await reportService.startReportGeneration(type, tenantId, Object.keys(params).length > 0 ? params : undefined);

        res.status(202).json({
          jobId: job.id,
          status: job.status,
          type: job.type,
          createdAt: job.createdAt,
        });
      } catch (error) {
        if (error instanceof Error && error.message.includes('maximum concurrent')) {
          sendError(res, ErrorCode.RATE_LIMIT_EXCEEDED, error.message)
        } else {
          throw error;
        }
      }
    } catch (error) {
      console.error("Report generation error:", error);
      sendError(res, ErrorCode.INTERNAL_SERVER_ERROR, "An unexpected error occurred while starting the report job");
    }
  },
);

/**
 * GET /api/reports/:jobId
 *
 * Gets the status of a report generation job
 *
 * @requires reports:generate scope
 *
 * @param {string} jobId - Unique report job ID
 *
 * @returns {object} Job status and artifact availability
 */
router.get(
  "/:jobId",
  requireApiKey(ApiScope.ENTERPRISE),
  validate({ params: reportJobParamsSchema }),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const validatedReq = req as ValidatedRequest<ReportJobParams>
      const { jobId } = validatedReq.validated.params

      const job = await reportService.getReportStatus(jobId);

      if (!job) {
        sendError(res, ErrorCode.NOT_FOUND, `Report job ${jobId} not found`);
        return;
      }

      const signedUrl = reportService.getSignedDownloadUrl(job);

      res.status(200).json({
        jobId: job.id,
        status: job.status,
        type: job.type,
        artifactUrl: signedUrl || job.artifactUrl || undefined,
        failureReason: job.failureReason,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      });
    } catch (error) {
      console.error("Report status query error:", error);
      sendError(res, ErrorCode.INTERNAL_SERVER_ERROR, "An unexpected error occurred while fetching report status");
    }
  },
);

/**
 * GET /api/reports/download/:key
 *
 * Downloads a report artifact using a signed URL.
 * The signature, expires, and key are validated before serving the data.
 *
 * **CORS policy:** Open — signed URLs are the credential; cross-origin
 * `GET` is allowed. See `docs/CORS_POLICY.md`.
 *
 * @param {string} key - Encoded storage key
 * @query {number} expires - Expiration timestamp (ms)
 * @query {string} signature - HMAC-SHA256 signature
 */
router.get(
  "/download/:key",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const key = decodeURIComponent(req.params.key);
      const expires = parseInt(req.query.expires as string, 10);
      const signature = req.query.signature as string;

      if (!expires || !signature) {
        sendError(res, ErrorCode.FIELD_REQUIRED, "Signed URL requires expires and signature query parameters");
        return;
      }

      const data = reportStorage.verifyAndRetrieve(key, expires, signature);

      if (!data) {
        sendError(res, ErrorCode.UNAUTHORIZED, "Invalid or expired signed URL");
        return;
      }

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${key.split("/").pop() || "report.pdf"}"`,
      );
      res.status(200).send(data);
    } catch (error) {
      console.error("Report download error:", error);
      sendError(res, ErrorCode.INTERNAL_SERVER_ERROR, "An unexpected error occurred while downloading the report");
    }
  },
);

export default router;

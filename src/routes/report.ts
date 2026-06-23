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
  type CreateReportBody,
  type ReportJobParams,
} from "../schemas/report.js";

const router = Router();
const reportRepository = new ReportRepository(pool);
const reportStorage = new ReportStorageService();
const reportService = new ReportService(reportRepository, reportStorage);

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
      const job = await reportService.startReportGeneration(type, tenantId);

      res.status(202).json({
        jobId: job.id,
        status: job.status,
        type: job.type,
        createdAt: job.createdAt,
      });
    } catch (error) {
      console.error("Report generation error:", error);
      res.status(500).json({
        error: "InternalServerError",
        message: "An unexpected error occurred while starting the report job",
      });
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
        res.status(404).json({
          error: "NotFound",
          message: `Report job ${jobId} not found`,
        });
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
      res.status(500).json({
        error: "InternalServerError",
        message: "An unexpected error occurred while fetching report status",
      });
    }
  },
);

/**
 * GET /api/reports/download/:key
 *
 * Downloads a report artifact using a signed URL.
 * The signature, expires, and key are validated before serving the data.
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
        res.status(400).json({
          error: "InvalidRequest",
          message: "Signed URL requires expires and signature query parameters",
        });
        return;
      }

      const data = reportStorage.verifyAndRetrieve(key, expires, signature);

      if (!data) {
        res.status(401).json({
          error: "Unauthorized",
          message: "Invalid or expired signed URL",
        });
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
      res.status(500).json({
        error: "InternalServerError",
        message: "An unexpected error occurred while downloading the report",
      });
    }
  },
);

export default router;

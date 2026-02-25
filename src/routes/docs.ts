import { Router, type Request, type Response } from 'express'
import swaggerUi from 'swagger-ui-express'
import { buildOpenApiSpec } from '../openapi/spec.js'

/**
 * Creates routes that serve runtime OpenAPI JSON and Swagger UI.
 */
export function createDocsRouter(): Router {
  const router = Router()
  const spec = buildOpenApiSpec()

  router.get('/openapi.json', (_req: Request, res: Response) => {
    res.status(200).json(spec)
  })

  router.use('/', swaggerUi.serve)
  router.get('/', swaggerUi.setup(spec))

  return router
}

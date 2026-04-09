import { verificationService } from '../services/verificationService.js'
import type { VerificationProof, BondSnapshot } from '../types/verification.js'
import * as crypto from 'crypto'
import express from 'express'
import request from 'supertest'
import { setupVerificationRoutes } from './verification.js'
import type { Application } from 'express'

describe('VerificationService', () => {
  const mockAddress = '0x1234567890123456789012345678901234567890'
  const mockBondSnapshot: BondSnapshot = {
    address: mockAddress,
    bondedAmount: '1000',
    bondStart: 1000000,
    bondDuration: 2592000,
    active: true,
  }

  describe('createProof', () => {
    it('should create a valid proof package', () => {
      const proof = verificationService.createProof(
        mockAddress,
        75,
        mockBondSnapshot,
        5
      )

      expect(proof.address).toBe(mockAddress)
      expect(proof.score).toBe(75)
      expect(proof.bondSnapshot).toEqual(mockBondSnapshot)
      expect(proof.attestationSummary.count).toBe(5)
      expect(proof.timestamp).toBeGreaterThan(0)
      expect(proof.hash).toBeDefined()
      expect(proof.canonical).toBeDefined()
    })

    it('should include expiry when specified', () => {
      const expiryMinutes = 60
      const proof = verificationService.createProof(
        mockAddress,
        75,
        mockBondSnapshot,
        5,
        expiryMinutes
      )

      expect(proof.expiresAt).toBeDefined()
      expect(proof.expiresAt).toBeGreaterThan(proof.timestamp)
    })

    it('should not include expiry when not specified', () => {
      const proof = verificationService.createProof(
        mockAddress,
        75,
        mockBondSnapshot,
        5
      )

      expect(proof.expiresAt).toBeUndefined()
    })

    it('should create proof with different scores', () => {
      const proof50 = verificationService.createProof(
        mockAddress,
        50,
        mockBondSnapshot,
        5
      )
      const proof75 = verificationService.createProof(
        mockAddress,
        75,
        mockBondSnapshot,
        5
      )

      expect(proof50.score).toBe(50)
      expect(proof75.score).toBe(75)
      expect(proof50.hash).not.toBe(proof75.hash)
    })
  })

  describe('verifyProofHash', () => {
    it('should verify a valid proof hash', () => {
      const proof = verificationService.createProof(
        mockAddress,
        75,
        mockBondSnapshot,
        5
      )

      expect(verificationService.verifyProofHash(proof)).toBe(true)
    })

    it('should detect invalid proof hash when score is tampered', () => {
      const proof = verificationService.createProof(
        mockAddress,
        75,
        mockBondSnapshot,
        5
      )

      proof.score = 50

      expect(verificationService.verifyProofHash(proof)).toBe(false)
    })

    it('should detect invalid proof hash when hash is modified', () => {
      const proof = verificationService.createProof(
        mockAddress,
        75,
        mockBondSnapshot,
        5
      )

      // Tamper with the hash directly
      proof.hash = 'tampered_hash_value'

      expect(verificationService.verifyProofHash(proof)).toBe(false)
    })

    it('should preserve canonical JSON format', () => {
      const proof = verificationService.createProof(
        mockAddress,
        75,
        mockBondSnapshot,
        5
      )

      // Canonical should be parseable
      const parsed = JSON.parse(proof.canonical)
      expect(parsed.address).toBe(mockAddress)
      expect(parsed.score).toBe(75)
    })
  })

  describe('signProof', () => {
    let privateKey: string
    let publicKey: string

    beforeAll(() => {
      const { privateKey: pk, publicKey: pubk } = crypto.generateKeyPairSync(
        'rsa',
        {
          modulusLength: 2048,
          publicKeyEncoding: { type: 'spki', format: 'pem' },
          privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        }
      )
      privateKey = pk
      publicKey = pubk
    })

    it('should sign a proof package', () => {
      const proof = verificationService.createProof(
        mockAddress,
        75,
        mockBondSnapshot,
        5
      )

      const signedProof = verificationService.signProof(proof, privateKey)

      expect(signedProof.signature).toBeDefined()
      expect(signedProof.signature.length).toBeGreaterThan(0)
    })

    it('should preserve proof data when signing', () => {
      const proof = verificationService.createProof(
        mockAddress,
        75,
        mockBondSnapshot,
        5
      )

      const signedProof = verificationService.signProof(proof, privateKey)

      expect(signedProof.address).toBe(proof.address)
      expect(signedProof.score).toBe(proof.score)
      expect(signedProof.hash).toBe(proof.hash)
      expect(signedProof.canonical).toBe(proof.canonical)
    })

    it('should verify a signed proof', () => {
      const proof = verificationService.createProof(
        mockAddress,
        75,
        mockBondSnapshot,
        5
      )

      const signedProof = verificationService.signProof(proof, privateKey)

      expect(verificationService.verifySignedProof(signedProof, publicKey)).toBe(
        true
      )
    })

    it('should fail verification with wrong key', () => {
      const proof = verificationService.createProof(
        mockAddress,
        75,
        mockBondSnapshot,
        5
      )

      const signedProof = verificationService.signProof(proof, privateKey)

      const { publicKey: differentKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      })

      expect(verificationService.verifySignedProof(signedProof, differentKey)).toBe(
        false
      )
    })

    it('should fail verification when signature is tampered', () => {
      const proof = verificationService.createProof(
        mockAddress,
        75,
        mockBondSnapshot,
        5
      )

      let signedProof = verificationService.signProof(proof, privateKey)

      // Tamper with signature
      signedProof.signature = 'tampered'

      expect(verificationService.verifySignedProof(signedProof, publicKey)).toBe(
        false
      )
    })
  })

  describe('isExpired', () => {
    it('should not be expired when no expiry set', () => {
      const proof = verificationService.createProof(
        mockAddress,
        75,
        mockBondSnapshot,
        5
      )

      expect(verificationService.isExpired(proof)).toBe(false)
    })

    it('should not be expired when expiry is in future', () => {
      const proof = verificationService.createProof(
        mockAddress,
        75,
        mockBondSnapshot,
        5,
        60
      )

      expect(verificationService.isExpired(proof)).toBe(false)
    })

    it('should be expired when time passes expiry', () => {
      const proof = verificationService.createProof(
        mockAddress,
        75,
        mockBondSnapshot,
        5,
        -1 // Expired 1 minute ago
      )

      expect(verificationService.isExpired(proof)).toBe(true)
    })

    it('should handle various expiry durations', () => {
      const expiredProof = verificationService.createProof(
        mockAddress,
        75,
        mockBondSnapshot,
        5,
        -60
      )
      const validProof = verificationService.createProof(
        mockAddress,
        75,
        mockBondSnapshot,
        5,
        120
      )

      expect(verificationService.isExpired(expiredProof)).toBe(true)
      expect(verificationService.isExpired(validProof)).toBe(false)
    })
  })

  describe('attestation hash consistency', () => {
    it('should generate consistent attestation hash for same count', () => {
      const proof1 = verificationService.createProof(
        mockAddress,
        75,
        mockBondSnapshot,
        5
      )

      const proof2 = verificationService.createProof(
        mockAddress,
        75,
        mockBondSnapshot,
        5
      )

      expect(proof1.attestationSummary.hash).toBe(proof2.attestationSummary.hash)
    })

    it('should generate different hashes for different attestation counts', () => {
      const proof5 = verificationService.createProof(
        mockAddress,
        75,
        mockBondSnapshot,
        5
      )

      const proof10 = verificationService.createProof(
        mockAddress,
        75,
        mockBondSnapshot,
        10
      )

      expect(proof5.attestationSummary.hash).not.toBe(proof10.attestationSummary.hash)
      expect(proof5.attestationSummary.count).toBe(5)
      expect(proof10.attestationSummary.count).toBe(10)
    })
  })

  describe('proof structure and canonical form', () => {
    it('should have all required proof fields', () => {
      const proof = verificationService.createProof(
        mockAddress,
        75,
        mockBondSnapshot,
        5
      )

      expect(proof).toHaveProperty('address')
      expect(proof).toHaveProperty('score')
      expect(proof).toHaveProperty('bondSnapshot')
      expect(proof).toHaveProperty('attestationSummary')
      expect(proof).toHaveProperty('timestamp')
      expect(proof).toHaveProperty('canonical')
      expect(proof).toHaveProperty('hash')
    })

    it('should have consistent canonical form ordering', () => {
      const proof1 = verificationService.createProof(
        mockAddress,
        75,
        mockBondSnapshot,
        5
      )

      const proof2 = verificationService.createProof(
        mockAddress,
        75,
        mockBondSnapshot,
        5
      )

      // Both should have canonical form (timestamps will differ but structure should be similar)
      expect(proof1.canonical).toContain('"address"')
      expect(proof1.canonical).toContain('"score"')
      expect(proof1.canonical).toContain('"bondSnapshot"')
    })
  })

  describe('Routes integration', () => {
    let app: Application

    beforeEach(() => {
      app = express()
      app.use(express.json())
      setupVerificationRoutes(app)
    })

    it('should have setupVerificationRoutes function', () => {
      expect(typeof setupVerificationRoutes).toBe('function')
    })

    it('should accept an express app', () => {
      const app = express()
      expect(() => {
        setupVerificationRoutes(app)
      }).not.toThrow()
    })

    it('GET /api/verification/:address returns unsigned proof by default', async () => {
      const response = await request(app).get(`/api/verification/${mockAddress}`)

      expect(response.status).toBe(200)
      expect(response.body.address).toBe(mockAddress)
      expect(response.body.signature).toBeUndefined()
      expect(response.body.hash).toBeDefined()
    })

    it('GET /api/verification/:address returns 500 when signing key is missing', async () => {
      delete process.env.VERIFICATION_PRIVATE_KEY
      const response = await request(app)
        .get(`/api/verification/${mockAddress}`)
        .query({ sign: 'true' })

      expect(response.status).toBe(500)
      expect(response.body.error).toBe('Signing key not configured')
    })

    it('GET /api/verification/:address signs proof when key is configured', async () => {
      const { privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      })
      process.env.VERIFICATION_PRIVATE_KEY = privateKey

      const response = await request(app)
        .get(`/api/verification/${mockAddress}`)
        .query({ sign: 'true', expiry: '30' })

      expect(response.status).toBe(200)
      expect(response.body.signature).toBeDefined()
      expect(response.body.expiresAt).toBeDefined()
    })

    it('POST /api/verification/verify returns 400 when proof is missing', async () => {
      const response = await request(app).post('/api/verification/verify').send({})

      expect(response.status).toBe(400)
      expect(response.body.error).toBe('Missing proof in request body')
    })

    it('POST /api/verification/verify reports hash and expiry validation errors', async () => {
      const proof = verificationService.createProof(
        mockAddress,
        75,
        mockBondSnapshot,
        5,
        -1,
      )
      proof.hash = 'tampered-hash'

      const response = await request(app)
        .post('/api/verification/verify')
        .send({ proof })

      expect(response.status).toBe(200)
      expect(response.body.valid).toBe(false)
      expect(response.body.errors).toContain('Hash verification failed')
      expect(response.body.errors).toContain('Proof has expired')
    })

    it('POST /api/verification/verify reports signature verification failure', async () => {
      const { privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      })
      const { publicKey: wrongPublicKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      })

      const proof = verificationService.createProof(mockAddress, 75, mockBondSnapshot, 5)
      const signedProof = verificationService.signProof(proof, privateKey)

      const response = await request(app)
        .post('/api/verification/verify')
        .send({ proof: signedProof, publicKey: wrongPublicKey })

      expect(response.status).toBe(200)
      expect(response.body.valid).toBe(false)
      expect(response.body.errors).toContain('Signature verification failed')
    })

    it('GET /api/verification/:address returns 500 when proof generation throws', async () => {
      const createProofSpy = vi
        .spyOn(verificationService, 'createProof')
        .mockImplementationOnce(() => {
          throw new Error('forced failure')
        })

      const response = await request(app).get(`/api/verification/${mockAddress}`)

      expect(response.status).toBe(500)
      expect(response.body.error).toBe('Failed to generate verification proof')
      createProofSpy.mockRestore()
    })
  })
})


import { describe, it, expect } from '@jest/globals';
import { getPaginationParams, buildPaginatedResponse } from './pagination.js';

describe('Pagination Helper', () => {
    describe('getPaginationParams', () => {
        it('should return default limits if query is empty', () => {
            const result = getPaginationParams({});
            expect(result).toEqual({ limit: 10, offset: 0 });
        });

        it('should parse valid limit and offset', () => {
            const result = getPaginationParams({ limit: '20', offset: '5' });
            expect(result).toEqual({ limit: 20, offset: 5 });
        });

        it('should handle cursor as offset', () => {
            const result = getPaginationParams({ limit: '20', cursor: '10' });
            expect(result).toEqual({ limit: 20, offset: 10 });
        });

        it('should cap limit at maxLimit', () => {
            const result = getPaginationParams({ limit: '200' }, 10, 100);
            expect(result).toEqual({ limit: 100, offset: 0 });
        });

        it('should fallback to default if limit is invalid', () => {
            const result = getPaginationParams({ limit: 'abc' });
            expect(result).toEqual({ limit: 10, offset: 0 });
        });

        it('should fallback to 0 if offset/cursor is invalid', () => {
            const result = getPaginationParams({ offset: 'abc' });
            expect(result).toEqual({ limit: 10, offset: 0 });
        });

        it('should handle negative values correctly', () => {
            const result = getPaginationParams({ limit: '-5', offset: '-2' });
            expect(result).toEqual({ limit: 10, offset: 0 }); // Fallbacks to defaults since invalid
        });

        it('should use defaultLimit and maxLimit when provided', () => {
            const result = getPaginationParams({}, 25);
            expect(result).toEqual({ limit: 25, offset: 0 });
        });
    });

    describe('buildPaginatedResponse', () => {
        it('should compute hasMore=true when data.length equals limit', () => {
            const result = buildPaginatedResponse([1, 2, 3], 3, 0);
            expect(result.pagination).toEqual({ nextOffset: 3, hasMore: true });
        });

        it('should compute hasMore=true when data.length > limit', () => {
            const result = buildPaginatedResponse([1, 2, 3, 4], 3, 0);
            expect(result.pagination).toEqual({ nextOffset: 4, hasMore: true });
        });

        it('should compute hasMore=false when data.length is less than limit', () => {
            const result = buildPaginatedResponse([1, 2], 3, 0);
            expect(result.pagination).toEqual({ nextOffset: null, hasMore: false });
        });

        it('should include total when provided', () => {
            const result = buildPaginatedResponse([1, 2], 3, 0, 100);
            expect(result.pagination).toEqual({ nextOffset: null, hasMore: false, total: 100 });
        });

        it('should work with custom offset', () => {
            const result = buildPaginatedResponse([1, 2, 3, 4], 4, 10);
            expect(result.pagination).toEqual({ nextOffset: 14, hasMore: true });
        });
    });
});

import { describe, expect, it } from 'vitest';

import {
  validateReviewSetIntegrity,
  validateSourceDocumentIntegrity,
  type ReviewSetHit,
  type ReviewSetSegment,
  type SelectedSourceReference,
} from './reviewSetIntegrity';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SOURCE_A = 'D:\\input\\a.pdf';
const SOURCE_B = 'D:\\input\\b.pdf';

type IntegrityDocument = {
  sourcePath: string;
  sourceSha256: string;
  integrityStatus: 'valid' | 'changed';
};

const documents: IntegrityDocument[] = [
  { sourcePath: SOURCE_A, sourceSha256: SHA_A, integrityStatus: 'valid' },
  { sourcePath: SOURCE_B, sourceSha256: SHA_B, integrityStatus: 'valid' },
];

const sources: SelectedSourceReference[] = [
  { sourcePath: SOURCE_A },
  { sourcePath: SOURCE_B },
];

function hit(overrides: Partial<ReviewSetHit> = {}): ReviewSetHit {
  return {
    sourcePath: SOURCE_A,
    sourcePage: 1,
    sourceSha256: SHA_A,
    ...overrides,
  };
}

function segment(overrides: Partial<ReviewSetSegment> = {}): ReviewSetSegment {
  return {
    id: 'segment-1',
    sourcePath: SOURCE_A,
    sourcePage: 1,
    sourceSha256: SHA_A,
    segmentNo: 1,
    ...overrides,
  };
}

describe('validateSourceDocumentIntegrity', () => {
  it('accepts an exact valid source/document set regardless of array order', () => {
    expect(validateSourceDocumentIntegrity(
      [
        { sourcePath: 'd:/INPUT/B.PDF' },
        { sourcePath: 'd:/input/a.pdf' },
      ],
      [documents[0], documents[1]],
    )).toEqual({ ok: true, message: '' });
  });

  it('rejects equal-count documents belonging to another selected source', () => {
    expect(validateSourceDocumentIntegrity(
      [{ sourcePath: 'D:\\input\\new-a.pdf' }, sources[1]],
      documents,
    ).ok).toBe(false);
  });

  it('rejects duplicate source paths after slash and case normalization', () => {
    expect(validateSourceDocumentIntegrity(
      [sources[0], { sourcePath: 'd:/INPUT/A.PDF' }],
      documents,
    ).ok).toBe(false);

    expect(validateSourceDocumentIntegrity(
      sources,
      [documents[0], { ...documents[1], sourcePath: 'D:/input/A.pdf' }],
    ).ok).toBe(false);
  });

  it('rejects missing source/document paths', () => {
    expect(validateSourceDocumentIntegrity(
      [sources[0]],
      documents,
    ).ok).toBe(false);

    expect(validateSourceDocumentIntegrity(
      sources,
      [documents[0]],
    ).ok).toBe(false);
  });

  it.each(['', '   ', '\t\n'])('rejects an empty selected source path: %j', (sourcePath) => {
    expect(validateSourceDocumentIntegrity(
      [{ sourcePath }, sources[1]],
      documents,
    ).ok).toBe(false);
  });

  it.each(['', '   ', '\t\n'])('rejects an empty document path: %j', (sourcePath) => {
    expect(validateSourceDocumentIntegrity(
      sources,
      [{ ...documents[0], sourcePath }, documents[1]],
    ).ok).toBe(false);
  });

  it('rejects a changed source document', () => {
    expect(validateSourceDocumentIntegrity(
      sources,
      [{ ...documents[0], integrityStatus: 'changed' }, documents[1]],
    ).ok).toBe(false);
  });

  it.each(['', ' '.repeat(64), ` ${SHA_A}`, `${SHA_A} `, 'g'.repeat(64), 'a'.repeat(63)])(
    'rejects a malformed or padded document SHA-256: %j',
    (sourceSha256) => {
      expect(validateSourceDocumentIntegrity(
        sources,
        [{ ...documents[0], sourceSha256 }, documents[1]],
      ).ok).toBe(false);
    },
  );

  it('accepts uppercase document SHA-256 without trimming it', () => {
    expect(validateSourceDocumentIntegrity(
      sources,
      [{ ...documents[0], sourceSha256: SHA_A.toUpperCase() }, documents[1]],
    ).ok).toBe(true);
  });
});

describe('validateReviewSetIntegrity', () => {
  it('accepts an exact valid hit and segment set', () => {
    expect(validateReviewSetIntegrity(
      documents,
      [
        hit(),
        hit({ sourcePath: SOURCE_B, sourcePage: 2, sourceSha256: SHA_B }),
      ],
      [
        segment(),
        segment({
          id: 'segment-2',
          sourcePath: SOURCE_B,
          sourcePage: 2,
          sourceSha256: SHA_B,
        }),
      ],
    )).toEqual({ ok: true, message: '' });
  });

  it('accepts separate logical source keys sharing one physical document path and SHA', () => {
    const sharedPath = 'D:\\shared\\same-content.pdf';
    const logicalA = 'd:/logical/a.pdf';
    const logicalB = 'd:/logical/b.pdf';
    const sharedDocuments = [{ sourcePath: sharedPath, sourceSha256: SHA_A }];
    const sharedHits = [
      hit({ sourcePath: sharedPath, sourceKey: logicalA }),
      hit({ sourcePath: sharedPath, sourceKey: logicalB }),
    ];
    const sharedSegments = [
      segment({ id: 'logical-a', sourcePath: sharedPath, sourceKey: logicalA }),
      segment({ id: 'logical-b', sourcePath: sharedPath, sourceKey: logicalB }),
    ];

    expect(validateReviewSetIntegrity(sharedDocuments, sharedHits, sharedSegments)).toEqual({ ok: true, message: '' });
    expect(validateReviewSetIntegrity(
      sharedDocuments,
      [hit({ sourcePath: sharedPath, sourceKey: logicalA })],
      [segment({ id: 'wrong-logical-source', sourcePath: sharedPath, sourceKey: logicalB })],
    ).ok).toBe(false);
  });

  it('allows empty hits and segments when source documents are valid', () => {
    expect(validateReviewSetIntegrity(documents, [], [])).toEqual({ ok: true, message: '' });
  });

  it('rejects unequal hit and segment counts and reports both counts', () => {
    const result = validateReviewSetIntegrity(documents, [hit()], []);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('1');
      expect(result.message).toContain('0');
    }
  });

  it('rejects an equal-count result whose source/page/order pairing is wrong', () => {
    const result = validateReviewSetIntegrity(
      documents,
      [
        hit(),
        hit({ sourcePath: SOURCE_B, sourcePage: 2, sourceSha256: SHA_B }),
      ],
      [
        segment({
          id: 'one',
          sourcePath: SOURCE_B,
          sourcePage: 2,
          sourceSha256: SHA_B,
        }),
        segment({
          id: 'two',
          sourcePath: SOURCE_A,
          sourcePage: 1,
          sourceSha256: SHA_A,
        }),
      ],
    );

    expect(result.ok).toBe(false);
  });

  it.each([
    { id: '', description: 'empty' },
    { id: '   ', description: 'whitespace-only' },
  ])('rejects an $description segment ID', ({ id }) => {
    expect(validateReviewSetIntegrity(documents, [hit()], [segment({ id })]).ok).toBe(false);
  });

  it('rejects duplicate segment IDs after trimming', () => {
    expect(validateReviewSetIntegrity(
      documents,
      [hit(), hit({ sourcePage: 2 })],
      [segment({ id: ' duplicate ' }), segment({ id: 'duplicate', sourcePage: 2 })],
    ).ok).toBe(false);
  });

  it('rejects a hit or review segment whose SHA-256 differs from its source document', () => {
    expect(validateReviewSetIntegrity(
      documents,
      [hit({ sourceSha256: SHA_B })],
      [segment()],
    ).ok).toBe(false);

    expect(validateReviewSetIntegrity(
      documents,
      [hit()],
      [segment({ sourceSha256: SHA_B })],
    ).ok).toBe(false);
  });

  it('rejects malformed or padded hit and segment SHA-256 values', () => {
    expect(validateReviewSetIntegrity(
      documents,
      [hit({ sourceSha256: ` ${SHA_A}` })],
      [segment()],
    ).ok).toBe(false);

    expect(validateReviewSetIntegrity(
      documents,
      [hit()],
      [segment({ sourceSha256: 'g'.repeat(64) })],
    ).ok).toBe(false);
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
  ])('rejects an invalid source page: %s', (sourcePage) => {
    expect(validateReviewSetIntegrity(
      documents,
      [hit({ sourcePage })],
      [segment({ sourcePage })],
    ).ok).toBe(false);
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
  ])('rejects an invalid segment number: %s', (segmentNo) => {
    expect(validateReviewSetIntegrity(
      documents,
      [hit()],
      [segment({ segmentNo })],
    ).ok).toBe(false);
  });

  it('requires segmentNo to be the one-based position inside each source/page group', () => {
    expect(validateReviewSetIntegrity(
      documents,
      [hit(), hit({ sourcePage: 1 })],
      [
        segment({ id: 'one', segmentNo: 1 }),
        segment({ id: 'two', segmentNo: 1 }),
      ],
    ).ok).toBe(false);

    expect(validateReviewSetIntegrity(
      documents,
      [
        hit({ sourcePage: 1 }),
        hit({ sourcePage: 2 }),
        hit({ sourcePage: 1 }),
      ],
      [
        segment({ id: 'one', sourcePage: 1, segmentNo: 1 }),
        segment({ id: 'two', sourcePage: 2, segmentNo: 1 }),
        segment({ id: 'three', sourcePage: 1, segmentNo: 2 }),
      ],
    ).ok).toBe(true);
  });

  it('matches source paths after slash, case, and surrounding-space normalization', () => {
    expect(validateReviewSetIntegrity(
      [{ sourcePath: 'D:\\input\\a.pdf', sourceSha256: SHA_A }],
      [{ sourcePath: ' d:/INPUT/A.PDF ', sourcePage: 1, sourceSha256: SHA_A.toUpperCase() }],
      [segment({ sourcePath: 'd:/input/a.pdf', sourceSha256: SHA_A.toUpperCase() })],
    ).ok).toBe(true);
  });

  it('rejects empty paths in documents, hits, and segments', () => {
    expect(validateReviewSetIntegrity(
      [{ sourcePath: '   ', sourceSha256: SHA_A }],
      [],
      [],
    ).ok).toBe(false);

    expect(validateReviewSetIntegrity(
      documents,
      [hit({ sourcePath: '   ' })],
      [segment()],
    ).ok).toBe(false);

    expect(validateReviewSetIntegrity(
      documents,
      [hit()],
      [segment({ sourcePath: '   ' })],
    ).ok).toBe(false);
  });

  it.each([
    { malformedHit: null, malformedSegment: segment(), description: 'null hit' },
    { malformedHit: undefined, malformedSegment: segment(), description: 'undefined hit' },
    { malformedHit: hit(), malformedSegment: null, description: 'null segment' },
    { malformedHit: hit(), malformedSegment: undefined, description: 'undefined segment' },
  ])('fails closed for a $description element', ({ malformedHit, malformedSegment }) => {
    const hits = [malformedHit] as unknown as ReviewSetHit[];
    const segments = [malformedSegment] as unknown as ReviewSetSegment[];

    expect(() => validateReviewSetIntegrity(documents, hits, segments)).not.toThrow();
    expect(validateReviewSetIntegrity(documents, hits, segments).ok).toBe(false);
  });

  it('fails closed for sparse hit and segment arrays', () => {
    const sparseHits = new Array<ReviewSetHit>(1);
    const sparseSegments = new Array<ReviewSetSegment>(1);

    expect(() => validateReviewSetIntegrity(documents, sparseHits, sparseSegments)).not.toThrow();
    expect(validateReviewSetIntegrity(documents, sparseHits, sparseSegments).ok).toBe(false);
  });
});

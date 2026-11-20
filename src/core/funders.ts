import { z } from 'zod3';

/*
 * Read-only client for the ProPublica Nonprofit Explorer API, which republishes
 * IRS exempt-organization records and Form 990 filing data.
 *
 * API documentation: https://projects.propublica.org/nonprofits/api
 *
 * This is funder research, not a CommonGrants source: organizations have no
 * open/closed status or deadlines, so they are exposed through separate tools
 * instead of being mixed into opportunity search results.
 */

export const PROPUBLICA_API_BASE_URL = 'https://projects.propublica.org/nonprofits/api/v2';
export const PROPUBLICA_PROFILE_BASE_URL =
  'https://projects.propublica.org/nonprofits/organizations/';
export const PROPUBLICA_ATTRIBUTION =
  'Source: ProPublica Nonprofit Explorer (https://projects.propublica.org/nonprofits/), ' +
  'derived from IRS filings. Cite ProPublica when publishing this data.';

/** ProPublica's fixed search page size. */
const PAGE_SIZE = 25;
/** How many filings to list per organization, most recent first. */
const MAX_FILINGS = 10;
/** How long to wait for ProPublica before giving up on a request. */
export const PROPUBLICA_TIMEOUT_MS = 10_000;

/** ProPublica usually sends EINs as numbers; tolerate digit strings too. */
const einSchema = z.union([z.number().int().nonnegative(), z.string().regex(/^\d{1,9}$/)]);

// Upstream shapes are validated loosely: only the fields this client reads.
const searchOrganizationSchema = z
  .object({
    ein: einSchema,
    name: z.string(),
    city: z.string().nullish(),
    state: z.string().nullish(),
    ntee_code: z.string().nullish(),
  })
  .passthrough();

// Rows are validated one at a time so a single odd record is skipped instead
// of failing the whole page; the counts fall back to null when unusable.
const searchResponseSchema = z
  .object({
    total_results: z.number().int().nonnegative().nullable().catch(null),
    num_pages: z.number().int().nonnegative().nullable().catch(null),
    organizations: z.array(z.unknown()).default([]),
  })
  .passthrough();

const filingWithDataSchema = z
  .object({
    tax_prd_yr: z.number().int(),
    formtype: z.number().int().nullish(),
    pdf_url: z.string().nullish(),
    totrevenue: z.number().nullish(),
    totfuncexpns: z.number().nullish(),
    totassetsend: z.number().nullish(),
    // 990-PF "contributions, gifts, grants paid" (per books).
    contrpdpbks: z.number().nullish(),
  })
  .passthrough();

const filingWithoutDataSchema = z
  .object({
    tax_prd_yr: z.number().int(),
    formtype: z.number().int().nullish(),
    pdf_url: z.string().nullish(),
  })
  .passthrough();

const organizationResponseSchema = z
  .object({
    organization: z
      .object({
        ein: einSchema,
        name: z.string(),
        city: z.string().nullish(),
        state: z.string().nullish(),
        ntee_code: z.string().nullish(),
        subsection_code: z.number().int().nullish(),
        foundation_code: z.number().int().nullish(),
        ruling_date: z.string().nullish(),
        asset_amount: z.number().nullish(),
        income_amount: z.number().nullish(),
      })
      .passthrough(),
    // Filings are validated one at a time; odd ones are skipped.
    filings_with_data: z.array(z.unknown()).nullish(),
    filings_without_data: z.array(z.unknown()).nullish(),
  })
  .passthrough();

export const organizationTypeValues = [
  'private_grantmaking_foundation',
  'private_operating_foundation',
  'public_charity',
  'other',
] as const;
export type OrganizationType = (typeof organizationTypeValues)[number];

export const formTypeValues = ['990', '990-EZ', '990-PF'] as const;
export type FormType = (typeof formTypeValues)[number];

export interface FunderSummary {
  ein: string;
  name: string;
  city: string | null;
  state: string | null;
  nteeCode: string | null;
  profileUrl: string;
}

export interface FunderFiling {
  taxYear: number;
  formType: FormType | null;
  pdfUrl: string | null;
}

export interface FunderProfile extends FunderSummary {
  subsectionCode: number | null;
  foundationCode: number | null;
  organizationType: OrganizationType | null;
  rulingDate: string | null;
  assetAmount: number | null;
  incomeAmount: number | null;
  latestFinancials: {
    taxYear: number;
    formType: FormType | null;
    totalRevenue: number | null;
    totalExpenses: number | null;
    totalAssets: number | null;
    /** Reported only on Form 990-PF; null for other forms. */
    grantsPaid: number | null;
  } | null;
  filings: FunderFiling[];
}

export interface FunderSearchResult {
  organizations: FunderSummary[];
  /** Null when ProPublica did not report a usable count. */
  total: number | null;
  page: number;
  /** Null when ProPublica did not report a usable count. */
  totalPages: number | null;
  /** Rows on this page dropped because they did not match the expected shape. */
  skipped: number;
}

export interface IFunderClient {
  searchOrganizations(params: {
    query: string;
    state?: string;
    page: number;
  }): Promise<FunderSearchResult>;
  /** Resolves null when the EIN is not in the IRS data. */
  getOrganization(ein: string): Promise<FunderProfile | null>;
}

/** Normalizes an EIN to nine digits; ProPublica returns EINs as numbers. */
export function formatEin(ein: number | string): string {
  return String(ein).replace(/-/g, '').padStart(9, '0');
}

function formType(code: number | null | undefined): FormType | null {
  switch (code) {
    case 0:
      return '990';
    case 1:
      return '990-EZ';
    case 2:
      return '990-PF';
    default:
      return null;
  }
}

/** Maps the IRS Business Master File foundation code to a coarse type. */
export function organizationType(code: number | null | undefined): OrganizationType | null {
  if (code == null) return null;
  if (code === 4) return 'private_grantmaking_foundation';
  if (code === 2 || code === 3) return 'private_operating_foundation';
  if ((code >= 10 && code <= 18) || (code >= 21 && code <= 24)) return 'public_charity';
  return 'other';
}

function summary(org: z.infer<typeof searchOrganizationSchema>): FunderSummary {
  const ein = formatEin(org.ein);
  return {
    ein,
    name: org.name,
    city: org.city ?? null,
    state: org.state ?? null,
    nteeCode: org.ntee_code ?? null,
    profileUrl: `${PROPUBLICA_PROFILE_BASE_URL}${ein}`,
  };
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Keeps the rows that match `schema` and drops the rest. */
function validRows<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, rows: unknown[]): T[] {
  return rows.flatMap((row) => {
    const parsed = schema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
}

/** Resolves undefined when the body is not JSON (for example an HTML error page). */
async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
}

export class ProPublicaFunderClient implements IFunderClient {
  constructor(
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
    private readonly baseUrl: string = PROPUBLICA_API_BASE_URL,
    private readonly timeoutMs: number = PROPUBLICA_TIMEOUT_MS,
  ) {}

  /**
   * Fetches and decodes one ProPublica response. Every failure is thrown as a
   * short, plain message because the tools pass it straight to the assistant.
   */
  private async request(
    what: string,
    path: string,
    params: URLSearchParams,
  ): Promise<{ status: number; ok: boolean; body: unknown }> {
    const query = params.toString();
    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}${query ? `?${query}` : ''}`, {
        headers: { Accept: 'application/json' },
        signal,
      });
      if (response.status === 429) {
        throw new Error('ProPublica rate limit reached (HTTP 429). Wait a minute and try again.');
      }
      // Reading the body is covered by the same timeout as the request.
      return { status: response.status, ok: response.ok, body: await readJson(response) };
    } catch (err) {
      if (signal.aborted) {
        throw new Error(`ProPublica ${what} timed out after ${this.timeoutMs / 1000} seconds`, {
          cause: err,
        });
      }
      if (err instanceof Error && err.message.startsWith('ProPublica ')) throw err;
      throw new Error(`ProPublica ${what} failed: could not reach the API`, { cause: err });
    }
  }

  async searchOrganizations({
    query,
    state,
    page,
  }: {
    query: string;
    state?: string;
    page: number;
  }): Promise<FunderSearchResult> {
    const params = new URLSearchParams({ q: query, page: String(page - 1) });
    if (state) params.set('state[id]', state);
    const response = await this.request('search', '/search.json', params);
    if (!response.ok && response.status !== 404) {
      throw new Error(`ProPublica search failed with HTTP ${response.status}`);
    }
    const parsed = searchResponseSchema.safeParse(response.body);
    if (!parsed.success) {
      // ProPublica answers an empty search with 404, normally with an empty
      // result body; treat a 404 without one the same way.
      if (response.status === 404) {
        return { organizations: [], total: 0, page, totalPages: 0, skipped: 0 };
      }
      throw new Error('ProPublica search returned a response in an unexpected format');
    }
    const body = parsed.data;
    const organizations = validRows(searchOrganizationSchema, body.organizations);
    return {
      organizations: organizations.map(summary),
      total: body.total_results,
      page,
      totalPages: body.num_pages,
      skipped: body.organizations.length - organizations.length,
    };
  }

  async getOrganization(ein: string): Promise<FunderProfile | null> {
    const response = await this.request(
      'organization lookup',
      `/organizations/${formatEin(ein)}.json`,
      new URLSearchParams(),
    );
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`ProPublica organization lookup failed with HTTP ${response.status}`);
    }
    const parsed = organizationResponseSchema.safeParse(response.body);
    if (!parsed.success) {
      throw new Error('ProPublica organization lookup returned a response in an unexpected format');
    }
    const body = parsed.data;
    const org = body.organization;
    const filingsWithData = validRows(filingWithDataSchema, body.filings_with_data ?? []);
    const filingsWithoutData = validRows(filingWithoutDataSchema, body.filings_without_data ?? []);
    // Unknown EINs come back as a placeholder record rather than a 404,
    // sometimes with unrelated PDF-only filings attached.
    if (org.subsection_code == null && filingsWithData.length === 0) return null;

    const latest = [...filingsWithData].sort((a, b) => b.tax_prd_yr - a.tax_prd_yr).at(0);
    const filings = [...filingsWithData, ...filingsWithoutData]
      .map((f) => ({
        taxYear: f.tax_prd_yr,
        formType: formType(f.formtype),
        pdfUrl: f.pdf_url ?? null,
      }))
      .sort((a, b) => b.taxYear - a.taxYear)
      .slice(0, MAX_FILINGS);

    return {
      ...summary(org),
      subsectionCode: org.subsection_code ?? null,
      foundationCode: org.foundation_code ?? null,
      organizationType: organizationType(org.foundation_code),
      rulingDate: org.ruling_date ?? null,
      assetAmount: org.asset_amount ?? null,
      incomeAmount: org.income_amount ?? null,
      latestFinancials: latest
        ? {
            taxYear: latest.tax_prd_yr,
            formType: formType(latest.formtype),
            totalRevenue: latest.totrevenue ?? null,
            totalExpenses: latest.totfuncexpns ?? null,
            totalAssets: latest.totassetsend ?? null,
            grantsPaid: latest.formtype === 2 ? (latest.contrpdpbks ?? null) : null,
          }
        : null,
      filings,
    };
  }
}

export { PAGE_SIZE as PROPUBLICA_PAGE_SIZE };

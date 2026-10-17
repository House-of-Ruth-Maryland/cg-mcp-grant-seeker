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

// Upstream shapes are validated loosely: only the fields this client reads.
const searchOrganizationSchema = z
  .object({
    ein: z.number().int(),
    name: z.string(),
    city: z.string().nullish(),
    state: z.string().nullish(),
    ntee_code: z.string().nullish(),
  })
  .passthrough();

const searchResponseSchema = z
  .object({
    total_results: z.number().int().nonnegative(),
    num_pages: z.number().int().nonnegative(),
    organizations: z.array(searchOrganizationSchema),
  })
  .passthrough();

const filingWithDataSchema = z
  .object({
    tax_prd_yr: z.number().int(),
    formtype: z.number().int(),
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
        ein: z.number().int(),
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
    filings_with_data: z.array(filingWithDataSchema).default([]),
    filings_without_data: z.array(filingWithoutDataSchema).default([]),
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
  total: number;
  page: number;
  totalPages: number;
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

export class ProPublicaFunderClient implements IFunderClient {
  constructor(
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
    private readonly baseUrl: string = PROPUBLICA_API_BASE_URL,
  ) {}

  private async request(path: string, params: URLSearchParams): Promise<Response> {
    const query = params.toString();
    return this.fetchImpl(`${this.baseUrl}${path}${query ? `?${query}` : ''}`, {
      headers: { Accept: 'application/json' },
    });
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
    const response = await this.request('/search.json', params);
    // ProPublica answers an empty search with 404 and an empty result body.
    if (!response.ok && response.status !== 404) {
      throw new Error(`ProPublica search failed with HTTP ${response.status}`);
    }
    const body = searchResponseSchema.parse(await response.json());
    return {
      organizations: body.organizations.map(summary),
      total: body.total_results,
      page,
      totalPages: body.num_pages,
    };
  }

  async getOrganization(ein: string): Promise<FunderProfile | null> {
    const response = await this.request(
      `/organizations/${formatEin(ein)}.json`,
      new URLSearchParams(),
    );
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`ProPublica organization lookup failed with HTTP ${response.status}`);
    }
    const body = organizationResponseSchema.parse(await response.json());
    const org = body.organization;
    // Unknown EINs come back as a placeholder record rather than a 404,
    // sometimes with unrelated PDF-only filings attached.
    if (org.subsection_code == null && body.filings_with_data.length === 0) return null;

    const latest = [...body.filings_with_data].sort((a, b) => b.tax_prd_yr - a.tax_prd_yr).at(0);
    const filings = [...body.filings_with_data, ...body.filings_without_data]
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

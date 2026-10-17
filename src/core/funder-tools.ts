import { z } from 'zod3';
import type { CoreToolRegistrar } from './tools.js';
import {
  PROPUBLICA_ATTRIBUTION,
  PROPUBLICA_PAGE_SIZE,
  ProPublicaFunderClient,
  formTypeValues,
  organizationTypeValues,
} from './funders.js';
import type { IFunderClient } from './funders.js';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const funderSummarySchema = z.object({
  ein: z.string(),
  name: z.string(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  nteeCode: z.string().nullable(),
  profileUrl: z.string(),
});

const filingSchema = z.object({
  taxYear: z.number().int(),
  formType: z.enum(formTypeValues).nullable(),
  pdfUrl: z.string().nullable(),
});

const funderProfileSchema = funderSummarySchema.extend({
  subsectionCode: z.number().int().nullable(),
  foundationCode: z.number().int().nullable(),
  organizationType: z.enum(organizationTypeValues).nullable(),
  rulingDate: z.string().nullable(),
  assetAmount: z.number().nullable(),
  incomeAmount: z.number().nullable(),
  latestFinancials: z
    .object({
      taxYear: z.number().int(),
      formType: z.enum(formTypeValues).nullable(),
      totalRevenue: z.number().nullable(),
      totalExpenses: z.number().nullable(),
      totalAssets: z.number().nullable(),
      grantsPaid: z.number().nullable(),
    })
    .nullable(),
  filings: z.array(filingSchema),
});

export const searchFundersInputSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .describe(
      'Keywords matched against organization name, alternate name, and city only, ' +
        'e.g. \'"community foundation" Baltimore\'. Supports quoted phrases, +required, -excluded.',
    ),
  state: z
    .string()
    .regex(/^[A-Za-z]{2}$/, 'Two-letter state code')
    .transform((s) => s.toUpperCase())
    .optional()
    .describe('Two-letter state code, e.g. MD'),
  page: z.number().int().min(1).default(1).describe('1-based results page'),
});

export const getFunderInputSchema = z.object({
  ein: z
    .string()
    .regex(/^\d{2}-?\d{7}$/, 'EIN must be nine digits, optionally formatted NN-NNNNNNN')
    .describe('Employer Identification Number from search_funders'),
});

/**
 * Registers the ProPublica funder-research tools. Kept separate from the
 * CommonGrants tools: these describe organizations from IRS filings, not
 * open grant opportunities.
 */
export function registerFunderTools(
  registerTool: CoreToolRegistrar,
  client: IFunderClient = new ProPublicaFunderClient(),
): void {
  registerTool(
    'search_funders',
    {
      title: 'Search funders (IRS / ProPublica)',
      description: [
        'Find U.S. nonprofits and foundations by name or city in IRS data via ProPublica Nonprofit Explorer.',
        'Use for funder prospect research, not for finding open grants: results have no deadlines',
        'or application status and never belong in an opportunity shortlist.',
        'Search matches names and cities only, not giving interests; for example search',
        '"foundation" or "community foundation" with a city and state.',
        `Returns up to ${PROPUBLICA_PAGE_SIZE} organizations per page. Use get_funder for type and finances.`,
      ].join(' '),
      inputSchema: searchFundersInputSchema.shape,
      outputSchema: {
        status: z.enum(['success', 'empty', 'error']),
        organizations: z.array(funderSummarySchema),
        total: z.number().int().nonnegative().nullable(),
        page: z.number().int().positive(),
        hasNextPage: z.boolean().nullable(),
        nextPage: z.number().int().positive().nullable(),
        error: z.string().nullable(),
        attribution: z.string(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input) => {
      const { query, state, page } = searchFundersInputSchema.parse(input);
      try {
        const result = await client.searchOrganizations({ query, state, page });
        const hasNextPage = page < result.totalPages;
        const structuredContent = {
          status: result.organizations.length === 0 ? ('empty' as const) : ('success' as const),
          organizations: result.organizations,
          total: result.total,
          page,
          hasNextPage,
          nextPage: hasNextPage ? page + 1 : null,
          error: null,
          attribution: PROPUBLICA_ATTRIBUTION,
        };
        return { content: [], structuredContent };
      } catch (err) {
        const structuredContent = {
          status: 'error' as const,
          organizations: [],
          total: null,
          page,
          hasNextPage: null,
          nextPage: null,
          error: errorMessage(err),
          attribution: PROPUBLICA_ATTRIBUTION,
        };
        return { content: [], structuredContent, isError: true };
      }
    },
  );

  registerTool(
    'get_funder',
    {
      title: 'Get funder profile (IRS / ProPublica)',
      description: [
        'Get an organization profile from IRS data via ProPublica Nonprofit Explorer by EIN.',
        '`organizationType` "private_grantmaking_foundation" marks private non-operating foundations,',
        'the usual private grantmakers. `latestFinancials.grantsPaid` is reported only on Form 990-PF.',
        'IRS data typically lags one to two years; filing PDFs (990-PF Part XV) list individual grants paid.',
        'Treat null as unknown, not zero. Cite ProPublica when publishing this data.',
      ].join(' '),
      inputSchema: getFunderInputSchema.shape,
      outputSchema: {
        status: z.enum(['success', 'not_found', 'error']),
        organization: funderProfileSchema.nullable(),
        error: z.string().nullable(),
        attribution: z.string(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input) => {
      const { ein } = getFunderInputSchema.parse(input);
      try {
        const organization = await client.getOrganization(ein);
        const structuredContent = {
          status: organization ? ('success' as const) : ('not_found' as const),
          organization,
          error: null,
          attribution: PROPUBLICA_ATTRIBUTION,
        };
        return { content: [], structuredContent };
      } catch (err) {
        const structuredContent = {
          status: 'error' as const,
          organization: null,
          error: errorMessage(err),
          attribution: PROPUBLICA_ATTRIBUTION,
        };
        return { content: [], structuredContent, isError: true };
      }
    },
  );
}

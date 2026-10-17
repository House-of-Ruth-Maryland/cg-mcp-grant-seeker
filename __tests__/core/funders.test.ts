import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProPublicaFunderClient, formatEin, organizationType } from '../../src/core/funders.js';
import type { IFunderClient } from '../../src/core/funders.js';
import { registerFunderTools } from '../../src/core/funder-tools.js';
import type { CoreToolRegistrar } from '../../src/core/tools.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fakeFetch(response: Response) {
  return vi.fn(async (_url: string, _init?: RequestInit) => response);
}

const searchBody = {
  total_results: 30,
  num_pages: 2,
  cur_page: 0,
  per_page: 25,
  organizations: [
    {
      ein: 12345678,
      name: 'Example Family Foundation',
      city: 'Baltimore',
      state: 'MD',
      ntee_code: 'T20',
    },
  ],
};

const organizationBody = {
  organization: {
    ein: 526036106,
    name: 'Example Foundation Inc',
    city: 'Baltimore',
    state: 'MD',
    ntee_code: null,
    subsection_code: 3,
    foundation_code: 4,
    ruling_date: '1955-03-01',
    asset_amount: 296434535,
    income_amount: 134252289,
  },
  filings_with_data: [
    {
      tax_prd_yr: 2022,
      formtype: 2,
      pdf_url: 'https://example.org/2022.pdf',
      totrevenue: 1,
      totfuncexpns: 2,
      totassetsend: 3,
      contrpdpbks: 4,
    },
    {
      tax_prd_yr: 2023,
      formtype: 2,
      pdf_url: 'https://example.org/2023.pdf',
      totrevenue: 19375292,
      totfuncexpns: 22243302,
      totassetsend: 334676808,
      contrpdpbks: 16093362,
    },
  ],
  filings_without_data: [
    { tax_prd_yr: 2018, formtype: 2, pdf_url: 'https://example.org/2018.pdf' },
  ],
};

describe('ProPublicaFunderClient', () => {
  it('maps search results and converts to ProPublica zero-based pages', async () => {
    const fetchImpl = fakeFetch(jsonResponse(searchBody));
    const client = new ProPublicaFunderClient(fetchImpl, 'https://api.test');

    const result = await client.searchOrganizations({ query: 'foundation', state: 'MD', page: 2 });

    const url = new URL(fetchImpl.mock.calls[0]![0]);
    expect(url.pathname).toBe('/search.json');
    expect(url.searchParams.get('q')).toBe('foundation');
    expect(url.searchParams.get('page')).toBe('1');
    expect(url.searchParams.get('state[id]')).toBe('MD');
    expect(result).toEqual({
      organizations: [
        {
          ein: '012345678',
          name: 'Example Family Foundation',
          city: 'Baltimore',
          state: 'MD',
          nteeCode: 'T20',
          profileUrl: 'https://projects.propublica.org/nonprofits/organizations/012345678',
        },
      ],
      total: 30,
      page: 2,
      totalPages: 2,
    });
  });

  it('treats a 404 search response as an empty result', async () => {
    const client = new ProPublicaFunderClient(
      fakeFetch(jsonResponse({ total_results: 0, num_pages: 0, organizations: [] }, 404)),
    );

    await expect(client.searchOrganizations({ query: 'nothing', page: 1 })).resolves.toMatchObject({
      organizations: [],
      total: 0,
    });
  });

  it('rejects other HTTP failures', async () => {
    const client = new ProPublicaFunderClient(fakeFetch(jsonResponse({}, 400)));

    await expect(client.searchOrganizations({ query: 'x', page: 500 })).rejects.toThrow('HTTP 400');
  });

  it('builds a profile from the most recent filing with data', async () => {
    const fetchImpl = fakeFetch(jsonResponse(organizationBody));
    const client = new ProPublicaFunderClient(fetchImpl, 'https://api.test');

    const profile = await client.getOrganization('52-6036106');

    expect(fetchImpl.mock.calls[0]![0]).toBe('https://api.test/organizations/526036106.json');
    expect(profile).toMatchObject({
      ein: '526036106',
      organizationType: 'private_grantmaking_foundation',
      foundationCode: 4,
      latestFinancials: {
        taxYear: 2023,
        formType: '990-PF',
        totalAssets: 334676808,
        grantsPaid: 16093362,
      },
    });
    expect(profile!.filings.map((f) => f.taxYear)).toEqual([2023, 2022, 2018]);
  });

  it('reports grants paid only for 990-PF filings', async () => {
    const body = {
      ...organizationBody,
      filings_with_data: [{ ...organizationBody.filings_with_data[1]!, formtype: 0 }],
    };
    const client = new ProPublicaFunderClient(fakeFetch(jsonResponse(body)));

    const profile = await client.getOrganization('526036106');

    expect(profile!.latestFinancials).toMatchObject({ formType: '990', grantsPaid: null });
  });

  it('returns null for the placeholder record ProPublica serves for unknown EINs', async () => {
    const client = new ProPublicaFunderClient(
      fakeFetch(
        jsonResponse({
          organization: { ein: 999999999, name: 'Unknown Organization', subsection_code: null },
          filings_with_data: [],
          filings_without_data: [
            { tax_prd_yr: 2008, formtype: 2, pdf_url: 'https://example.org/x.pdf' },
          ],
        }),
      ),
    );

    await expect(client.getOrganization('999999999')).resolves.toBeNull();
  });
});

describe('funder helpers', () => {
  it('pads EINs to nine digits', () => {
    expect(formatEin(12345678)).toBe('012345678');
    expect(formatEin('52-6036106')).toBe('526036106');
  });

  it('classifies IRS foundation codes', () => {
    expect(organizationType(4)).toBe('private_grantmaking_foundation');
    expect(organizationType(3)).toBe('private_operating_foundation');
    expect(organizationType(15)).toBe('public_charity');
    expect(organizationType(0)).toBe('other');
    expect(organizationType(null)).toBeNull();
  });
});

const openConnections: Array<{ client: Client; server: McpServer }> = [];

async function connect(funders: IFunderClient): Promise<Client> {
  const server = new McpServer({ name: 'test-server', version: '1.0.0' });
  const registerTool = server.registerTool.bind(server) as unknown as CoreToolRegistrar;
  registerFunderTools(registerTool, funders);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  openConnections.push({ client, server });
  return client;
}

afterEach(async () => {
  await Promise.all(
    openConnections.splice(0).map(async ({ client, server }) => {
      await client.close();
      await server.close();
    }),
  );
});

describe('funder tools', () => {
  it('registers read-only tools with structured results and attribution', async () => {
    const client = await connect(new ProPublicaFunderClient(fakeFetch(jsonResponse(searchBody))));

    const { tools } = await client.listTools();
    expect(tools.map(({ name }) => name)).toEqual(['search_funders', 'get_funder']);
    expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);

    const result = await client.callTool({
      name: 'search_funders',
      arguments: { query: 'foundation', state: 'md' },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      status: 'success',
      total: 30,
      page: 1,
      hasNextPage: true,
      nextPage: 2,
      error: null,
      attribution: expect.stringContaining('ProPublica'),
    });
  });

  it('reports not_found and upstream errors without throwing', async () => {
    const funders: IFunderClient = {
      searchOrganizations: vi.fn(async () => {
        throw new Error('ProPublica search failed with HTTP 503');
      }),
      getOrganization: vi.fn(async () => null),
    };
    const client = await connect(funders);
    await client.listTools();

    const search = await client.callTool({ name: 'search_funders', arguments: { query: 'x' } });
    const detail = await client.callTool({ name: 'get_funder', arguments: { ein: '12-3456789' } });

    expect(search.isError).toBe(true);
    expect(search.structuredContent).toMatchObject({
      status: 'error',
      error: 'ProPublica search failed with HTTP 503',
    });
    expect(detail.structuredContent).toMatchObject({ status: 'not_found', organization: null });
    expect(funders.getOrganization).toHaveBeenCalledWith('12-3456789');
  });
});

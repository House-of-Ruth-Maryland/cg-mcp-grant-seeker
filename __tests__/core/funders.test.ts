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
    ein: 1,
    name: 'Example Foundation Inc',
    city: 'Baltimore',
    state: 'MD',
    ntee_code: null,
    subsection_code: 3,
    foundation_code: 4,
    ruling_date: '2000-01-01',
    asset_amount: 1000000,
    income_amount: 200000,
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
      totrevenue: 300000,
      totfuncexpns: 250000,
      totassetsend: 1100000,
      contrpdpbks: 150000,
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
      skipped: 0,
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

  it('treats a 404 search response without a JSON body as an empty result', async () => {
    const client = new ProPublicaFunderClient(
      fakeFetch(new Response('<html>Not found</html>', { status: 404 })),
    );

    await expect(client.searchOrganizations({ query: 'nothing', page: 1 })).resolves.toEqual({
      organizations: [],
      total: 0,
      page: 1,
      totalPages: 0,
      skipped: 0,
    });
  });

  it('skips odd search rows instead of failing the whole page', async () => {
    const body = {
      ...searchBody,
      organizations: [
        { ein: null, name: 'Example Row Without An EIN' },
        ...searchBody.organizations,
        'not an object',
        { ein: '87654321', name: 'Example String EIN Fund' },
      ],
    };
    const client = new ProPublicaFunderClient(fakeFetch(jsonResponse(body)));

    const result = await client.searchOrganizations({ query: 'example', page: 1 });

    expect(result.organizations.map(({ ein }) => ein)).toEqual(['012345678', '087654321']);
    expect(result.skipped).toBe(2);
  });

  it('keeps search rows when the result counts are unusable', async () => {
    const body = { ...searchBody, total_results: 'many', num_pages: null };
    const client = new ProPublicaFunderClient(fakeFetch(jsonResponse(body)));

    await expect(client.searchOrganizations({ query: 'example', page: 1 })).resolves.toMatchObject({
      organizations: [{ ein: '012345678' }],
      total: null,
      totalPages: null,
    });
  });

  it('reports non-JSON and unexpected bodies with a short message', async () => {
    const html = () => fakeFetch(new Response('<html>Bad gateway</html>', { status: 200 }));

    await expect(
      new ProPublicaFunderClient(html()).searchOrganizations({ query: 'x', page: 1 }),
    ).rejects.toThrow('ProPublica search returned a response in an unexpected format');
    await expect(new ProPublicaFunderClient(html()).getOrganization('000000001')).rejects.toThrow(
      'ProPublica organization lookup returned a response in an unexpected format',
    );
    await expect(
      new ProPublicaFunderClient(fakeFetch(jsonResponse({ organization: 'nope' }))).getOrganization(
        '000000001',
      ),
    ).rejects.toThrow('ProPublica organization lookup returned a response in an unexpected format');
  });

  it('reports rate limiting with a short message for both calls', async () => {
    const limited = () => fakeFetch(new Response('Too many requests', { status: 429 }));
    const message = 'ProPublica rate limit reached (HTTP 429). Wait a minute and try again.';

    await expect(
      new ProPublicaFunderClient(limited()).searchOrganizations({ query: 'x', page: 1 }),
    ).rejects.toThrow(message);
    await expect(
      new ProPublicaFunderClient(limited()).getOrganization('000000001'),
    ).rejects.toThrow(message);
  });

  it('times out a request that never answers', async () => {
    const hangingFetch = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason));
        }),
    );
    const client = new ProPublicaFunderClient(hangingFetch, 'https://api.test', 20);

    await expect(client.searchOrganizations({ query: 'x', page: 1 })).rejects.toThrow(
      'ProPublica search timed out after 0.02 seconds',
    );
    await expect(client.getOrganization('000000001')).rejects.toThrow(
      'ProPublica organization lookup timed out after 0.02 seconds',
    );
    expect(hangingFetch.mock.calls[0]![1]!.signal).toBeInstanceOf(AbortSignal);
  });

  it('hides network error details behind a short message', async () => {
    const client = new ProPublicaFunderClient(
      vi.fn(async () => {
        throw new TypeError('fetch failed: getaddrinfo ENOTFOUND internal.host.test');
      }),
    );

    await expect(client.searchOrganizations({ query: 'x', page: 1 })).rejects.toThrow(
      'ProPublica search failed: could not reach the API',
    );
  });

  it('skips odd filings instead of failing the profile', async () => {
    const body = {
      ...organizationBody,
      filings_with_data: [
        { tax_prd_yr: 'unknown', formtype: 2 },
        ...organizationBody.filings_with_data,
        { tax_prd_yr: 2024, formtype: null, totrevenue: 5 },
      ],
      filings_without_data: [null, ...organizationBody.filings_without_data],
    };
    const client = new ProPublicaFunderClient(fakeFetch(jsonResponse(body)));

    const profile = await client.getOrganization('000000001');

    expect(profile!.filings.map((f) => f.taxYear)).toEqual([2024, 2023, 2022, 2018]);
    expect(profile!.latestFinancials).toMatchObject({
      taxYear: 2024,
      formType: null,
      totalRevenue: 5,
      grantsPaid: null,
    });
  });

  it('builds a profile from the most recent filing with data', async () => {
    const fetchImpl = fakeFetch(jsonResponse(organizationBody));
    const client = new ProPublicaFunderClient(fetchImpl, 'https://api.test');

    const profile = await client.getOrganization('00-0000001');

    expect(fetchImpl.mock.calls[0]![0]).toBe('https://api.test/organizations/000000001.json');
    expect(profile).toMatchObject({
      ein: '000000001',
      organizationType: 'private_grantmaking_foundation',
      foundationCode: 4,
      latestFinancials: {
        taxYear: 2023,
        formType: '990-PF',
        totalAssets: 1100000,
        grantsPaid: 150000,
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

    const profile = await client.getOrganization('000000001');

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
    expect(formatEin('00-0000001')).toBe('000000001');
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
      skipped: 0,
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

  it('keeps error text to one short line', async () => {
    const funders: IFunderClient = {
      searchOrganizations: vi.fn(async () => {
        throw new Error(`Unexpected failure\n${'detail '.repeat(200)}`);
      }),
      getOrganization: vi.fn(async () => {
        throw new Error('x'.repeat(500));
      }),
    };
    const client = await connect(funders);
    await client.listTools();

    const search = await client.callTool({ name: 'search_funders', arguments: { query: 'x' } });
    const detail = await client.callTool({ name: 'get_funder', arguments: { ein: '000000001' } });

    expect(search.structuredContent).toMatchObject({
      status: 'error',
      skipped: 0,
      error: 'Unexpected failure',
    });
    const detailError = (detail.structuredContent as { error: string }).error;
    expect(detail.isError).toBe(true);
    expect(detailError).toHaveLength(200);
    expect(detailError.endsWith('...')).toBe(true);
  });
});

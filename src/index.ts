import Fastify, { FastifyReply, FastifyRequest } from 'fastify';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { randomUUID } from 'crypto';

const fastify = Fastify({ logger: true });

const SERVER_PORT = parseInt(process.env.SERVER_PORT || '8899', 10);
const ACCESS_TOKEN = process.env.ACCESS_TOKEN; // Example access token - 'ab123456-7890-cdef-1234-567890abcdef'

if (!ACCESS_TOKEN) {
  console.error('ACCESS_TOKEN environment variable is required');
  process.exit(1);
}

interface SearchParams {
  query: string;
  limit?: number;
}

interface FetchParams {
  url: string;
}

interface SearchResultItem {
  title: string | null;
  url: string | null;
  excerpt: string | null;
  contentType: string[] | null;
  product: string[] | null;
  role: string[] | null;
  type: string | null;
  date: string | null;
  language: string[] | null;
  source: string | null;
  permanentId: string | null;
}

interface JsonRpcRequest {
  jsonrpc: string;
  id?: string | number | null;
  method: string;
  params?: any;
}

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface ToolInvocationResult {
  content: Array<{ type: string; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: unknown;
  handler: (args: any) => Promise<ToolInvocationResult>;
}

const SUPPORTED_PROTOCOL_VERSION = '2025-06-18';

const DEFAULT_RESULT_LIMIT = 5;
const MAX_RESULT_LIMIT = 10;
const SEARCH_CACHE_TTL_MS = 60_000;
const ARTICLE_CACHE_TTL_MS = 120_000;

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

const searchCache = new Map<string, CacheEntry<SearchResultItem[]>>();
const articleCache = new Map<string, CacheEntry<string | null>>();

const getCacheValue = <T>(
  cache: Map<string, CacheEntry<T>>,
  key: string
): T | undefined => {
  const entry = cache.get(key);
  if (!entry) {
    return undefined;
  }
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
};

const setCacheValue = <T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  value: T,
  ttlMs: number
) => {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
};

const sanitizeResultLimit = (value: number | undefined): number => {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return DEFAULT_RESULT_LIMIT;
  }
  const floored = Math.floor(value);
  if (floored <= 0) {
    return DEFAULT_RESULT_LIMIT;
  }
  return Math.min(MAX_RESULT_LIMIT, floored);
};

const search_experience_league = async (
  params: SearchParams
): Promise<SearchResultItem[]> => {
  const { query, limit } = params;
  const resultLimit = sanitizeResultLimit(limit);
  const normalizedQuery = query.trim();
  const cacheKey = `${normalizedQuery.toLowerCase()}::${resultLimit}`;
  const cachedResults = getCacheValue(searchCache, cacheKey);
  if (cachedResults !== undefined) {
    return cachedResults;
  }

  const queryString = normalizedQuery.length ? normalizedQuery : query;
  const searchUrl =
    'https://platform.cloud.coveo.com/rest/search/v2?organizationId=adobev2prod9e382h1q';
  const response = await axios.post(
    searchUrl,
    {
      q: queryString,
      locale: 'en',
      searchHub: 'Experience League Learning Hub',
      numberOfResults: resultLimit,
    },
    {
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
    }
  );
  const rawResults = Array.isArray(response.data?.results)
    ? response.data.results
    : [];
  const trimmedResults = rawResults.slice(0, resultLimit);
  const mappedResults = trimmedResults.map((result: any): SearchResultItem => {
    const raw = result?.raw ?? {};
    const dateValue =
      typeof raw.date === 'number' ? new Date(raw.date).toISOString() : null;
    return {
      title: result?.title ?? null,
      url: result?.clickUri ?? null,
      excerpt: result?.excerpt ?? null,
      contentType: Array.isArray(raw.el_contenttype)
        ? raw.el_contenttype
        : Array.isArray(raw.contenttype)
        ? raw.contenttype
        : null,
      product: Array.isArray(raw.el_product) ? raw.el_product : null,
      role: Array.isArray(raw.el_role) ? raw.el_role : null,
      type: raw.el_type ?? null,
      date: dateValue,
      language: Array.isArray(raw.language)
        ? raw.language
        : Array.isArray(raw.syslanguage)
        ? raw.syslanguage
        : null,
      source: raw.syssource ?? raw.source ?? null,
      permanentId: raw.permanentid ?? null,
    };
  });
  setCacheValue(searchCache, cacheKey, mappedResults, SEARCH_CACHE_TTL_MS);
  return mappedResults;
};

const buildPlainHtmlUrl = (input: string): string => {
  const parsed = new URL(input);
  parsed.hash = '';
  const { pathname } = parsed;
  if (pathname.endsWith('.plain.html')) {
    return parsed.toString();
  }
  if (pathname.endsWith('.html')) {
    parsed.pathname = pathname.replace(/\.html$/, '.plain.html');
  } else if (pathname.endsWith('/')) {
    const trimmed = pathname.replace(/\/+$/, '');
    parsed.pathname = `${trimmed}.plain.html`;
  } else {
    parsed.pathname = `${pathname}.plain.html`;
  }
  return parsed.toString();
};

const extractCleanHtml = ($: cheerio.CheerioAPI): string | null => {
  $(
    '.back-to-browsing, .breadcrumbs, .doc-actions, .mini-toc, .target-insertion'
  ).remove();
  const fragments = $.root()
    .children()
    .map((_, el) => $.html(el)?.trim())
    .get()
    .filter((fragment) => Boolean(fragment));
  const combined = fragments.join('\n').trim();
  return combined.length ? combined : null;
};

const fetch_article_content = async (
  params: FetchParams
): Promise<string | null> => {
  const { url } = params;
  const plainUrl = buildPlainHtmlUrl(url);
  const candidates = plainUrl === url ? [plainUrl] : [plainUrl, url];
  const cacheKey = plainUrl;
  const cachedContent = getCacheValue(articleCache, cacheKey);
  if (cachedContent !== undefined) {
    return cachedContent;
  }

  for (const candidate of candidates) {
    try {
      const response = await axios.get(candidate, {
        headers: {
          Accept: 'text/html',
        },
      });
      const $ = cheerio.load(response.data);
      const content = extractCleanHtml($);
      if (content !== null) {
        setCacheValue(articleCache, cacheKey, content, ARTICLE_CACHE_TTL_MS);
        return content;
      }
    } catch (error) {
      // Try the next candidate URL on failure.
    }
  }
  setCacheValue(articleCache, cacheKey, null, ARTICLE_CACHE_TTL_MS);
  return null;
};

const toolRegistry: Record<string, ToolDefinition> = {
  search_experience_league: {
    name: 'search_experience_league',
    title: 'Experience League Search',
    description: 'Search the Adobe Experience League documentation index',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Query string to submit to Experience League search',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_RESULT_LIMIT,
          description:
            'Maximum number of results to return (default 5, max 10)',
        },
      },
      required: ['query'],
    },
    handler: async (args: any) => {
      const results = await search_experience_league(args as SearchParams);
      const normalizeWhitespace = (
        value: string | null | undefined
      ): string | null =>
        typeof value === 'string'
          ? value.replace(/\s+/g, ' ').trim() || null
          : null;
      const truncate = (value: string, maxLength: number): string =>
        value.length <= maxLength
          ? value
          : `${value.slice(0, maxLength - 1).trimEnd()}…`;

      const summaryLines: string[] = [];

      if (results.length === 0) {
        summaryLines.push('No results found.');
      } else {
        results.forEach((result, index) => {
          const title = result.title ?? 'Untitled result';
          const header = result.url
            ? `${index + 1}. [${title}](${result.url})`
            : `${index + 1}. ${title}`;
          summaryLines.push(header);

          const excerptValue = normalizeWhitespace(result.excerpt);
          const displayExcerpt = excerptValue
            ? truncate(excerptValue, 240)
            : '(no excerpt available)';
          summaryLines.push(`   - Excerpt: ${displayExcerpt}`);

          const metaParts: string[] = [];
          if (result.type) metaParts.push(result.type);
          if (Array.isArray(result.contentType) && result.contentType.length) {
            metaParts.push(
              `Content: ${truncate(result.contentType.join(', '), 80)}`
            );
          }
          if (Array.isArray(result.product) && result.product.length) {
            metaParts.push(
              `Products: ${truncate(result.product.join(', '), 80)}`
            );
          }
          if (result.date) metaParts.push(`Date: ${result.date.slice(0, 10)}`);
          if (result.source)
            metaParts.push(`Source: ${truncate(result.source, 60)}`);
          if (metaParts.length) {
            summaryLines.push(`   - ${metaParts.join(' · ')}`);
          }
        });
      }

      const text = summaryLines.join('\n');
      return {
        content: [{ type: 'text', text }],
        structuredContent: {
          results,
        },
      };
    },
  },
  fetch_article_content: {
    name: 'fetch_article_content',
    title: 'Experience League Content Fetcher',
    description:
      'Retrieve the main HTML content for an Experience League article',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          format: 'uri',
          description: 'Absolute URL for the Experience League page to fetch',
        },
      },
      required: ['url'],
    },
    handler: async (args: any) => {
      const content = await fetch_article_content(args as FetchParams);
      const text = content ?? '';
      return {
        content: [{ type: 'text', text }],
        structuredContent: { html: content },
      };
    },
  },
};

const sessions = new Map<string, { protocolVersion: string }>();

const makeErrorResponse = (
  id: string | number | null | undefined,
  error: JsonRpcError
) => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error,
});

fastify.post('/mcp', async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    if (
      request.body === null ||
      typeof request.body !== 'object' ||
      Array.isArray(request.body)
    ) {
      return reply.status(400).send(
        makeErrorResponse(null, {
          code: -32600,
          message: 'Invalid request body',
        })
      );
    }

    const body = request.body as JsonRpcRequest;
    const isNotification = body.id === undefined;

    fastify.log.info(
      { method: body.method, id: body.id, params: body.params },
      'Received MCP message'
    );

    if (body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
      return reply.status(400).send(
        makeErrorResponse(body.id, {
          code: -32600,
          message: 'Invalid JSON-RPC request',
        })
      );
    }

    if (body.method === 'initialize') {
      if (isNotification) {
        return reply.status(400).send(
          makeErrorResponse(null, {
            code: -32600,
            message: 'initialize requires id',
          })
        );
      }
      const params = body.params ?? {};
      const requestedVersion = params.protocolVersion;
      if (requestedVersion && requestedVersion !== SUPPORTED_PROTOCOL_VERSION) {
        return reply.send(
          makeErrorResponse(body.id, {
            code: -32001,
            message: `Unsupported protocol version ${requestedVersion}`,
            data: { supportedVersions: [SUPPORTED_PROTOCOL_VERSION] },
          })
        );
      }
      const sessionId = randomUUID();
      sessions.set(sessionId, { protocolVersion: SUPPORTED_PROTOCOL_VERSION });
      reply.header('Mcp-Session-Id', sessionId);
      return reply.send({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          protocolVersion: SUPPORTED_PROTOCOL_VERSION,
          serverInfo: {
            name: 'experience-league-mcp',
            version: '1.0.0',
          },
          capabilities: {
            tools: {
              listChanged: false,
            },
          },
        },
      });
    }

    const sessionHeader = request.headers['mcp-session-id'];
    const sessionId = Array.isArray(sessionHeader)
      ? sessionHeader[0]
      : sessionHeader;
    if (!sessionId || !sessions.has(sessionId)) {
      return reply.send(
        makeErrorResponse(body.id, {
          code: -32002,
          message: 'Session not initialized',
        })
      );
    }

    if (isNotification) {
      return reply.status(202).send();
    }

    if (body.method === 'tools/list') {
      const tools = Object.values(toolRegistry).map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
      return reply.send({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          tools,
        },
      });
    }

    if (body.method === 'tools/call') {
      const params = body.params ?? {};
      const name = params.name;
      const args = params.arguments ?? {};
      if (typeof name !== 'string' || !toolRegistry[name]) {
        return reply.send(
          makeErrorResponse(body.id, {
            code: -32601,
            message: 'Tool not found',
          })
        );
      }
      const tool = toolRegistry[name];
      try {
        const invocation = await tool.handler(args);
        return reply.send({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            content: invocation.content,
            structuredContent: invocation.structuredContent,
            isError: invocation.isError ?? false,
          },
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Unknown tool error';
        return reply.send({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            content: [{ type: 'text', text: message }],
            isError: true,
          },
        });
      }
    }

    return reply.send(
      makeErrorResponse(body.id, {
        code: -32601,
        message: `Method ${body.method} not found`,
      })
    );
  } catch (error) {
    fastify.log.error(error);
    return reply
      .status(500)
      .send(
        makeErrorResponse(null, { code: -32603, message: 'Internal error' })
      );
  }
});

fastify.get('/mcp', async (_request: FastifyRequest, reply: FastifyReply) => {
  return reply.status(405).header('Allow', 'POST').send();
});

const start = async () => {
  try {
    await fastify.listen({ port: SERVER_PORT, host: '127.0.0.1' });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();

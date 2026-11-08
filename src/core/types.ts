// Shared types. Notion objects are kept loose (`any`) on purpose: the converter must
// survive new block/property types that the API adds without breaking the build.
/* eslint-disable @typescript-eslint/no-explicit-any */

export type NotionObj = any;

/** A block as returned by GET /blocks/{id}/children, with `children` filled in recursively. */
export interface NBlock extends Record<string, any> {
	id: string;
	type: string;
	has_children?: boolean;
	children?: NBlock[];
}

export interface PageSnap {
	page: NotionObj;          // GET /pages/{id}
	blocks: NBlock[];         // recursive block tree
}

export interface DataSourceSnap {
	data_source: NotionObj;   // GET /data_sources/{id}
	rows: NotionObj[];        // POST /data_sources/{id}/query results (page objects)
	/** GET /data_sources/{id}/templates (round 5): the database's page templates; each template is also a page
	 *  in `Snapshot.pages` (fetched with GET /pages/{id} + its block tree) */
	templates?: { id: string; name: string; is_default?: boolean }[];
}

export interface DatabaseSnap {
	database: NotionObj;      // GET /databases/{id}
	views: NotionObj[];       // GET /views/{id} for each view of the database
	data_sources: DataSourceSnap[];
}

/** Everything the converter needs. Produced by the API crawler (plugin) or loaded from fixtures (tests). */
export interface Snapshot {
	roots: string[];                              // root page ids picked by the user
	pages: Record<string, PageSnap>;
	databases: Record<string, DatabaseSnap>;
	/** block or page id → comments (GET /comments?block_id=…), only un-resolved comments are exposed by the API */
	comments?: Record<string, NotionObj[]>;
	/** user id → user object (GET /users), to show comment authors / people by name */
	users?: Record<string, NotionObj>;
	/** crawl problems (HTTP errors, truncation, missing access) – shown at the top of the import report */
	errors?: string[];
	/** false when the crawl was cancelled or hit errors: a re-sync must then not archive "missing" pages */
	complete?: boolean;
	/** what the API reported while crawling (for the Notion-vs-vault verification) */
	stats?: CrawlStats;
}

export interface CrawlStats {
	searchPages?: number;          // pages returned by /search (scope = whole integration)
	searchDataSources?: number;
	trashedSkipped?: number;
	pagesFetched: number;
	rowsReported: Record<string, number>;   // data source id → rows returned by query (all pages of results)
	blocks: number;                // blocks fetched (all depths)
	comments: number;
	paginatedProperties: number;   // property values completed through /pages/{id}/properties/{prop} (>25 items)
	reusedPages?: number;
	trustedPages?: number;         // quick re-sync: reused without the top-level block check (edited before our copy)
	reusedDatabases?: number;      // quick re-sync: databases taken from the raw backup (no schema / views / rows reads)          // incremental re-sync: unchanged pages taken from the previous raw backup
	templatesReported?: number;    // database templates listed by /data_sources/{id}/templates
	markdownCopies?: number;       // pages whose Notion Markdown (GET /pages/{id}/markdown) was saved
}

export interface ConvertOptions {
	/** Folder inside the vault where everything goes. */
	targetFolder: string;
	/** Folder (relative to targetFolder) for downloaded Notion-hosted files. */
	attachmentsFolder: string;
	/** Write static HTML header (cover + icon) into the note body too (works without the plugin). */
	staticHeader: boolean;
	/** Render select / multi-select / status as colored pills in Bases via html() formulas. */
	coloredPills: boolean;
	/** IANA zone used to show UTC timestamps (created / edited time, comments) */
	timeZone?: string;
	/** notion id (normalized) → path where the user keeps this page / database locally (moved or renamed in the
	 *  vault after an earlier import). The converter writes it THERE instead of at its Notion path (no duplicate). */
	relocate?: Record<string, string>;
	/** notion ids (pages, databases or data sources) the user chose "以后不再同步" for: not written, not archived */
	ignore?: string[];
}

export const DEFAULT_OPTIONS: ConvertOptions = {
	targetFolder: 'Notion',
	attachmentsFolder: '_attachments',
	staticHeader: false,
	coloredPills: true,
};

export interface OutFile {
	path: string;          // vault-relative path
	content: string;
}

/** A Notion-hosted file that must be downloaded (signed URL) and saved at `path`. */
export interface AssetRequest {
	url: string;           // full URL as given by the API (may be signed / expiring)
	key: string;           // URL without query string (stable identity)
	path: string;          // vault-relative destination
}

export interface ConvertResult {
	files: OutFile[];
	assets: AssetRequest[];
	warnings: string[];
	/** property → value → Notion color, for the plugin's pill painter */
	colors: Record<string, Record<string, string>>;
	/** one line per Notion formula / rollup property: live Bases formula or static fallback (+ why) */
	formulaReport: import('./formula.ts').FormulaReportEntry[];
	/** .base path → Notion database icon (Obsidian may rewrite .base files and drop the comment line) */
	baseIcons: Record<string, string>;
	/** Notion-vs-output accounting (see audit.ts) */
	audit: import('./audit.ts').Audit;
	/** notion id → vault path of every page / row / database written (for re-sync and the manifest) */
	idPaths: Record<string, string>;
	/** items skipped because of the ignore list (+ every row / template that belongs to them) */
	skipped?: { id: string; title: string; kind: 'page' | 'database' | 'row' | 'template' }[];
}

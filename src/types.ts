import type MarkdownIt from "markdown-it";

export interface SidebarItem {
  text: string;
  link?: string;
  items?: SidebarItem[];
  collapsed?: boolean;
}

export interface NavItem {
  text: string;
  link: string;
}

export interface PageData {
  route: string;
  relativePath: string;
  title: string;
  description: string;
  headings: string[];
  text: string;
  frontmatter: Record<string, unknown>;
}

export interface MarkdownConfig {
  configure?: (md: MarkdownIt) => void;
  lineNumbers?: boolean;
  math?: boolean;
  slugify?: (value: string) => string;
  imageLazyLoading?: boolean;
}

export interface SsgConfig {
  root?: string;
  srcDir?: string;
  outDir?: string;
  cacheDir?: string;
  publicDir?: string;
  base?: string;
  title?: string;
  description?: string;
  lang?: string;
  port?: number;
  ignore?: string[];
  ignoreDeadLinks?: boolean | Array<string | RegExp>;
  markdown?: MarkdownConfig;
  sidebar?: SidebarItem[];
  nav?: NavItem[];
  theme?: string;
  head?: Array<[string, Record<string, string>, string?]>;
}

export interface ResolvedSsgConfig extends Required<
  Omit<SsgConfig, "theme" | "head" | "markdown" | "ignoreDeadLinks">
> {
  configFile: string;
  theme?: string;
  head: Array<[string, Record<string, string>, string?]>;
  markdown: MarkdownConfig;
  ignoreDeadLinks: boolean | Array<string | RegExp>;
}

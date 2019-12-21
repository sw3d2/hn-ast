import * as fs from 'fs';
import * as cp from 'child_process';
import * as fspath from 'path';
import * as htmlparser2 from 'htmlparser2';
import { Node as HtmlNode, Element as HtmlElement } from 'domhandler';
import * as domutils from 'domutils';

const USAGE_FILE = 'usage.txt';
const HN_URL_BASE = 'https://news.ycombinator.com/item?id=';
const HN_SCHEME = 'hn:';
const TMP_HTML_FILE = 'index.html';
const HN_COMMENT_NODE_CLASS = '.comtr';
const HN_COMMENT_TEXT_CLASS = '.commtext';
const HN_INDENT_NODE_CLASS = '.ind';

const COLORS = {
  'paragraph': '#f00',
  'content': '#c00',
  'comment': '#0c0',
  'topic': '#00f',
};

interface VastFile {
  format: 'vast';
  version: string;
  source: string;
  colors: typeof COLORS;
  timestamp: string;
  vast: VastNode;
}

interface VastNode {
  ref?: string;
  name?: string;
  type: keyof typeof COLORS;
  size?: number;
  children?: VastNode[];
}

interface Comment {
  id: string;
  text: string[];
  indent: number;
  children?: Comment[];
}

let args = process.argv.slice(2);
let [inputPath, tmpdir = '.', outputPath] = args;

if (!inputPath) {
  let text = fs.readFileSync(USAGE_FILE, 'utf8');
  console.log(text);
  process.exit(0);
}

inputPath = resolveFullUrl(inputPath);
let html = downloadInputHtml(inputPath);
let tree = parseHtml(html);
let vast = generateAST(tree);
let file = generateVastFile(vast);
let json = JSON.stringify(file, null, 2);

if (outputPath)
  fs.writeFileSync(outputPath, json, 'utf8');
else
  console.log(json);

function resolveFullUrl(uri: string) {
  if (uri.startsWith(HN_SCHEME))
    uri = HN_URL_BASE + uri.replace(HN_SCHEME, '');
  return uri;
}

function downloadInputHtml(uri: string) {
  if (uri.startsWith(HN_SCHEME))
    uri = HN_URL_BASE + uri.replace(HN_SCHEME, '');

  if (uri.startsWith(HN_URL_BASE)) {
    let respath = fspath.join(tmpdir, TMP_HTML_FILE);
    if (fs.existsSync(respath))
      throw new Error(`File already exists: ${respath}`);
    let command = `wget -O ${respath} ${uri}`;
    cp.execSync(command);
    uri = respath;
  }

  return fs.readFileSync(uri, 'utf8');
}

function parseHtml(html: string): HtmlNode[] {
  return htmlparser2.parseDOM(html);
}

function generateAST(roots: HtmlNode[]): VastNode {
  let comments = findElements(roots, HN_COMMENT_NODE_CLASS);
  let parsed = comments.map(parseComment);
  let croot = nestComments(parsed);
  return {
    ref: inputPath,
    type: 'topic',
    children: makeVastNode(croot).children,
  };
}

function findElements(roots: HtmlNode[], selector: string): HtmlElement[] {
  return domutils.find(el =>
    domutils.isTag(el) && matchesSelector(el, selector),
    roots, true, Infinity) as HtmlElement[];
}

function matchesSelector(el: HtmlElement, sel: string) {
  let [tagName, ...classes] = sel.split('.');
  if (tagName && el.tagName != tagName)
    return false;
  let cset = new Set(
    (el.attribs['class'] || '')
      .trim().split(/\s+/g));
  for (let cname of classes)
    if (!cset.has(cname))
      return false;
  return true;
}

function getNodeText(node: HtmlNode | null): string | null {
  if (!node)
    return null;
  if (domutils.isText(node))
    return node.data;
  if (domutils.isTag(node))
    return getNodeText(node.firstChild);
  return null;
}

function parseComment(commNode: HtmlElement): Comment {
  let commId = commNode.attribs['id'];
  let [textNode] = findElements([commNode], HN_COMMENT_TEXT_CLASS);
  let [indentNode] = findElements([commNode], HN_INDENT_NODE_CLASS);
  let [imgNode] = findElements([indentNode], 'img');
  let pNodes = domutils.find(
    node => domutils.isText(node) ||
      domutils.isTag(node) &&
      node.tagName == 'p',
    textNode.children, false, Infinity);
  let text = pNodes.map(getNodeText)
    .filter(s => s && s.length > 0) as string[];
  let indent = +imgNode.attribs['width'];
  return {
    id: commId,
    indent,
    text,
  };
}

function nestComments(comments: Comment[]) {
  let croot: Comment = { id: '', text: [], indent: -1, children: [] };
  let chain: Comment[] = [croot];

  for (let index = 0; index < comments.length; index++) {
    let comm = comments[index];
    let parent = chain[chain.length - 1];

    if (comm.indent > parent.indent) {
      parent.children = parent.children || [];
      parent.children.push(comm);
      chain.push(comm);
    } else {
      chain.pop();
      index--;
    }
  }

  return croot;
}

function makeVastNode(root: Comment): VastNode {
  let textNode: VastNode = {
    name: 'text',
    type: 'content',
    children: root.text.map(p => {
      return {
        name: 'p',
        type: 'paragraph',
        size: p.length,
      };
    })
  };

  let nodes: VastNode[] = [textNode];
  if (root.children)
    nodes.push(...root.children.map(makeVastNode));

  return {
    ref: inputPath + '#' + root.id,
    name: root.id,
    type: 'comment',
    children: nodes,
  };
}

function generateVastFile(root: VastNode): VastFile {
  return {
    format: 'vast',
    version: '1.0.0',
    source: inputPath,
    colors: COLORS,
    timestamp: new Date().toJSON(),
    vast: root,
  };
}

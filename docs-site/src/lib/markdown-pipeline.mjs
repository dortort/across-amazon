const isElement = (node, tagName) => node.type === "element" && node.tagName === tagName;

const headerCellLabels = (table, context) => {
  const head = table.children.find((child) => isElement(child, "thead"));
  const row = head?.children.find((child) => isElement(child, "tr"));
  const cells = row?.children.filter((child) => isElement(child, "th")) ?? [];
  return cells.map((cell) => context.textContent(cell).trim()).filter(Boolean);
};

export const tableScrollPlugin = {
  name: "table-scroll",
  element: {
    filter: ["table"],
    visit(node, context) {
      const label = headerCellLabels(node, context).join(", ") || "Table";
      context.wrapNode(node, {
        type: "element",
        tagName: "div",
        properties: { className: ["table-scroll"], role: "region", ariaLabel: label, tabIndex: 0 },
        children: [],
      });
    },
  },
};

export const stripLeadingHeadingPlugin = {
  name: "strip-leading-heading",
  before(root, context) {
    const firstElement = root.children.find((child) => child.type === "element");
    if (!firstElement || !isElement(firstElement, "h1")) return;
    const astro = context.data.astro;
    if (astro) astro.frontmatter = { ...astro.frontmatter, title: context.textContent(firstElement).trim() };
    context.removeNode(firstElement);
  },
};

export const autolinkLiteralTextPlugin = {
  name: "autolink-literal-text",
  options: { position: true },
  link(node, context) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    const written = context.source.slice(start, end);
    if (written !== context.textContent(node)) return;
    return { type: "text", value: written };
  },
};

export const markdownPipeline = () => ({
  name: "markdown-pipeline",
  hooks: {
    "astro:config:setup": ({ config }) => {
      const { processor } = config.markdown;
      if (processor.name !== "satteri") {
        throw new Error(`markdown-pipeline expects the default Sätteri Markdown processor, found ${processor.name}.`);
      }
      processor.options.features.smartPunctuation = false;
      processor.options.mdastPlugins.push(autolinkLiteralTextPlugin);
      processor.options.hastPlugins.push(stripLeadingHeadingPlugin, tableScrollPlugin);
    },
  },
});

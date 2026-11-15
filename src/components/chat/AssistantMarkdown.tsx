import { parseMarkdown, type MarkdownInline } from "../../lib/markdown";

function InlineNodes({ nodes }: { nodes: MarkdownInline[] }) {
  return (
    <>
      {nodes.map((node, index) => {
        if (node.kind === "code") return <code key={index}>{node.text}</code>;
        if (node.kind === "strong") return <strong key={index}><InlineNodes nodes={node.inline} /></strong>;
        if (node.kind === "em") return <em key={index}><InlineNodes nodes={node.inline} /></em>;
        if (node.kind === "link") {
          return <a key={index} href={node.href} target="_blank" rel="noreferrer noopener">{node.text}</a>;
        }
        return <span key={index}>{node.text}</span>;
      })}
    </>
  );
}

export function AssistantMarkdown({ text }: { text: string }) {
  return (
    <>
      {parseMarkdown(text).map((block, index) => {
        if (block.kind === "code") {
          return <pre key={index} className="chat-md-code"><code>{block.text}</code></pre>;
        }
        if (block.kind === "heading") {
          // Demoted inside a bubble: the page owns h1/h2, a message never does.
          const Tag = (["h3", "h4", "h5"] as const)[block.level - 1];
          return <Tag key={index}><InlineNodes nodes={block.inline} /></Tag>;
        }
        if (block.kind === "list") {
          const items = block.items.map((item, itemIndex) => (
            <li key={itemIndex}><InlineNodes nodes={item} /></li>
          ));
          return block.ordered ? <ol key={index}>{items}</ol> : <ul key={index}>{items}</ul>;
        }
        return <p key={index}><InlineNodes nodes={block.inline} /></p>;
      })}
    </>
  );
}

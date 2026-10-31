// Small, non-executing reader for server-rendered listing controls. It does
// not load CSS, JavaScript, images, or create a browser/DOM runtime.
const decode = (value) => String(value).replace(/&#(?:x([0-9a-f]+)|(\d+));/gi,(original,hex,num)=>{const code=parseInt(hex||num,hex?16:10);return code<=0x10ffff?String.fromCodePoint(code):original;}).replace(/&nbsp;/g," ").replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&apos;/g,"'");
const clean = (value) => decode(value).replace(/\s+/g," ").trim();
const titleKey = (value) => clean(value).replace(/^(?:sold|pending)\s*[·•]\s*/i,"");
const actions = /^(buy now|make an offer|out of stock|send seller a message)$/i;

export function readHttpListingActions(html, listingTitle) {
  if (!listingTitle) return "";
  const root={tag:"root",parts:[],parent:null,hidden:false,disabled:false};
  const stack=[root],nodes=[];
  // React streaming sends completed UI in hidden S:n segments plus template
  // instructions. Only segments explicitly completed by rci/rsi are readable;
  // ordinary hidden controls remain excluded. No page scripts are executed.
  const completed=new Set();
  for(const template of html.matchAll(/<template\b[^>]*>/gi)) {
    if(/\bdata-r(?:ci|si)(?:\s|=|>)/i.test(template[0])) {
      const id=template[0].match(/\bdata-sid\s*=\s*["'](S:\d+)["']/i)?.[1];
      if(id)completed.add(id);
    }
  }
  const source=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,"").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,"").replace(/<!--[\s\S]*?-->/g,"");
  const tokens=/<\/?[a-z][^>]*>|[^<]+/gi;
  let match;
  while((match=tokens.exec(source))) {
    const token=match[0];
    if(token[0]!=="<") {stack.at(-1).parts.push(token);continue;}
    const closing=token.match(/^<\/([\w:-]+)/);
    if(closing) {
      const index=stack.findLastIndex(node=>node.tag===closing[1].toLowerCase());
      if(index>0)stack.length=index;
      continue;
    }
    const tag=token.match(/^<([\w:-]+)/)?.[1]?.toLowerCase();if(!tag)continue;
    if(nodes.length>=40000)return "";
    const attrs={};
    for(const item of token.slice(tag.length+1).matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attrs[item[1].toLowerCase()]=decode(item[2]??item[3]??item[4]??"");
    const parent=stack.at(-1),style=attrs.style||"";
    const completedSegment=tag==="div"&&completed.has(attrs.id);
    const node={tag,attrs,parent,parts:[],hidden:parent.hidden||attrs['aria-hidden']==="true"||('hidden' in attrs&&!completedSegment)||/display\s*:\s*none|visibility\s*:\s*hidden/i.test(style),disabled:parent.disabled||attrs['aria-disabled']==="true"||'disabled' in attrs};
    parent.parts.push(node);nodes.push(node);
    if(!/^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/.test(tag)&&!token.endsWith('/>'))stack.push(node);
  }
  // Reverse order avoids recursion depth problems on a large response.
  for(const node of [...nodes,root].reverse()) {
    if(node===root)continue;
    node.text=clean(node.parts.map(part=>typeof part==="string"?part:part.hidden?"":part.text||"").join(" "));
  }
  const headings=nodes.filter(node=>!node.hidden&&node.tag==="h1"&&titleKey(node.text)===titleKey(listingTitle));
  if(headings.length!==1)return "";
  const controls=nodes.filter(node=>!node.hidden&&(node.tag==="button"||node.attrs.role==="button")&&actions.test(node.text||node.attrs['aria-label']||""));
  for(let scope=headings[0].parent;scope&&scope!==root;scope=scope.parent) {
    if(scope.tag==="body"||scope.tag==="html")break;
    const found=controls.filter(node=>{for(let p=node.parent;p;p=p.parent)if(p===scope)return true;return false;});
    if(!found.length)continue;
    const labels=found.map(node=>{const label=(node.text||node.attrs['aria-label']).toLowerCase();return label==="buy now"&&node.disabled?"thâm buy now":label;});
    // CSS-only disabled styling cannot be computed here. aria-disabled and
    // disabled attributes are explicit evidence; JS-dependent cases may differ.
    if(labels.includes("out of stock"))return "out of stock";
    return [...new Set(labels)].join("- ");
  }
  return "";
}

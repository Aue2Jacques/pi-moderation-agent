// Glossary: every term the console uses without explaining, from the one list in labels.ts (also behind Term).
import { GLOSSARY } from "../labels.ts";
import { PageHead, Panel } from "../ui.tsx";

export function Glossary() {
  return (
    <>
      <PageHead title="术语表" desc="控制台中出现的专有名词。页面上带虚线下划线的词，点击即可查看同样的解释。" />
      <Panel>
        <ul className="glossary">
          {Object.entries(GLOSSARY).map(([k, v]) => <li key={k}><b>{k}</b><span>{v}</span></li>)}
        </ul>
      </Panel>
    </>
  );
}

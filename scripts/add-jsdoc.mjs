/**
 * Script de manutenção: adiciona JSDoc (pt-BR) automaticamente em declarações públicas/exportadas.
 *
 * O objetivo é aumentar a cobertura de documentação do repositório sem depender de edições manuais
 * em centenas de arquivos. O script:
 * - Varre `.ts/.tsx/.mts` (exclui `node_modules`, `.next` e outros diretórios gerados).
 * - Descobre símbolos exportados por módulo via TypeChecker (inclui `export default Foo`).
 * - Para cada função/classe exportada (e métodos públicos de classes exportadas), insere um bloco
 *   JSDoc (por exemplo, `/** ... *\/`) com descrição, `@param` e `@returns` em pt-BR quando ainda não existir.
 *
 * Execução:
 * - `node scripts/add-jsdoc.mjs`
 *
 * Observações:
 * - O texto do resumo é propositalmente genérico (não tenta “adivinhar” regras de negócio).
 * - A descrição de parâmetros tenta aplicar heurísticas comuns (req/res/options/id, etc.).
 * - O script evita sobrescrever docstrings existentes.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import process from "node:process";

const REPO_ROOT = path.resolve(process.cwd());
const TSCONFIG_PATH = path.join(REPO_ROOT, "tsconfig.json");

/** Diretórios ignorados (gerados, vendor ou temporários). */
const IGNORE_DIRS = new Set([
  "node_modules",
  ".next",
  "dist",
  "build",
  "out",
  "coverage",
  ".turbo",
  ".vercel",
  "testsprite_tests/tmp",
]);

/** Extensões consideradas “source” neste repo. */
const SOURCE_EXTS = new Set([".ts", ".tsx", ".mts"]);

function isIgnoredPath(filePath) {
  const rel = path.relative(REPO_ROOT, filePath).replaceAll("\\", "/");
  if (!rel || rel.startsWith("..")) return true;
  if (rel.includes("/node_modules/")) return true;
  if (rel.includes("/.next/")) return true;
  if (rel.includes("/dist/") || rel.includes("/build/") || rel.includes("/out/")) return true;
  if (rel.includes("/coverage/") || rel.includes("/.turbo/") || rel.includes("/.vercel/")) return true;
  if (rel.includes("/testsprite_tests/tmp/")) return true;
  return false;
}

function isSourceFile(filePath) {
  const ext = path.extname(filePath);
  if (!SOURCE_EXTS.has(ext)) return false;
  if (filePath.endsWith(".d.ts")) return false;
  if (isIgnoredPath(filePath)) return false;
  return true;
}

function walkDir(dir) {
  const out = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    const rel = path.relative(REPO_ROOT, p).replaceAll("\\", "/");
    if (ent.isDirectory()) {
      if (IGNORE_DIRS.has(rel) || IGNORE_DIRS.has(ent.name)) continue;
      if (isIgnoredPath(p)) continue;
      out.push(...walkDir(p));
      continue;
    }
    if (ent.isFile() && isSourceFile(p)) out.push(p);
  }
  return out;
}

function readTsConfig(tsconfigPath) {
  const readResult = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (readResult.error) {
    const msg = ts.flattenDiagnosticMessageText(readResult.error.messageText, "\n");
    throw new Error(`Falha ao ler tsconfig: ${msg}`);
  }
  const config = ts.parseJsonConfigFileContent(readResult.config, ts.sys, path.dirname(tsconfigPath));
  if (config.errors?.length) {
    const first = config.errors[0];
    const msg = ts.flattenDiagnosticMessageText(first.messageText, "\n");
    throw new Error(`Falha ao parsear tsconfig: ${msg}`);
  }
  return config;
}

function getLineStart(text, pos) {
  const idx = text.lastIndexOf("\n", Math.max(0, pos - 1));
  return idx === -1 ? 0 : idx + 1;
}

function getIndent(text, pos) {
  const lineStart = getLineStart(text, pos);
  const m = /^[\t ]*/.exec(text.slice(lineStart, pos));
  return m ? m[0] : "";
}

function hasLeadingJSDoc(text, node, sf) {
  const start = node.getStart(sf, false);
  const fullStart = node.getFullStart();
  const leading = text.slice(fullStart, start);
  // Consideramos JSDoc apenas quando há bloco `/** ... */` antes da declaração.
  return /\/\*\*[\s\S]*?\*\//.test(leading);
}

function isHttpHandlerName(name) {
  return ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(name);
}

function describeParam(name) {
  const lower = name.toLowerCase();
  if (lower === "req" || lower === "request") return "Objeto da requisição.";
  if (lower === "res" || lower === "response") return "Objeto da resposta.";
  if (lower === "ctx" || lower === "context") return "Contexto de execução.";
  if (lower === "options" || lower.endsWith("options")) return "Opções de configuração.";
  if (lower === "id" || lower.endsWith("id")) return "Identificador do recurso.";
  if (lower.includes("organization") && lower.endsWith("id")) return "Identificador da organização (tenant).";
  if (lower === "user" || lower.endsWith("user")) return "Informações do usuário.";
  if (lower === "payload" || lower === "body" || lower.endsWith("payload")) return "Dados de entrada (payload).";
  if (lower === "params") return "Parâmetros de rota.";
  if (lower === "searchparams") return "Parâmetros de busca (querystring).";
  return `Parâmetro \`${name}\`.`;
}

function describeReturn(typeStr) {
  const t = (typeStr || "").trim();
  if (!t || t === "void" || t === "undefined") return "Não retorna valor.";
  if (t === "Promise<void>" || t === "Promise<undefined>") return "Retorna uma Promise resolvida sem valor.";
  return `Retorna um valor do tipo \`${t}\`.`;
}

function escapeBackticks(s) {
  return String(s).replaceAll("`", "\\`");
}

function buildJsDoc({ kind, name, params, returnType, fileRel }) {
  const safeName = escapeBackticks(name || "default");
  const isTSX = fileRel.endsWith(".tsx");
  const isHook = safeName.startsWith("use") && /^[A-Z]/.test(safeName.slice(3));
  const isComponent = isTSX && /^[A-Z]/.test(safeName);
  const isApiRoute = fileRel.includes("app/api/");

  let summary = "";
  if (kind === "class") {
    summary = `Classe \`${safeName}\` do projeto.`;
  } else if (kind === "method") {
    summary = `Método público \`${safeName}\`.`;
  } else if (kind === "constructor") {
    summary = `Constrói uma instância de \`${safeName}\`.`;
  } else if (isApiRoute && isHttpHandlerName(safeName)) {
    summary = `Handler HTTP \`${safeName}\` deste endpoint (Next.js Route Handler).`;
  } else if (isHook) {
    summary = `Hook React \`${safeName}\` que encapsula uma lógica reutilizável.`;
  } else if (isComponent) {
    summary = `Componente React \`${safeName}\`.`;
  } else {
    summary = `Função pública \`${safeName}\` do projeto.`;
  }

  const lines = [];
  lines.push("/**");
  lines.push(` * ${summary}`);
  if (params.length) lines.push(" *");
  for (const p of params) {
    const type = p.type ? `{${p.type}} ` : "";
    lines.push(` * @param ${type}${p.name} - ${describeParam(p.name)}`);
  }
  if (returnType != null) {
    lines.push(` * @returns {${returnType || "unknown"}} ${describeReturn(returnType)}`);
  }
  lines.push(" */");
  return lines.join("\n");
}

function getSignatureReturnTypeString(checker, decl) {
  const sig = checker.getSignatureFromDeclaration(decl);
  if (!sig) return null;
  const returnType = checker.getReturnTypeOfSignature(sig);
  return checker.typeToString(returnType);
}

function getParamTypeString(checker, param) {
  try {
    const t = checker.getTypeAtLocation(param);
    const str = checker.typeToString(t);
    return str || null;
  } catch {
    return null;
  }
}

function getNodeName(node, sf) {
  if (node.name && ts.isIdentifier(node.name)) return node.name.getText(sf);
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.getText(sf);
  if (ts.isClassDeclaration(node) && node.name) return node.name.getText(sf);
  if (ts.isMethodDeclaration(node) && node.name) return node.name.getText(sf);
  if (ts.isConstructorDeclaration(node)) {
    const cls = node.parent && ts.isClassLike(node.parent) ? node.parent : null;
    return cls?.name?.getText(sf) || "Constructor";
  }
  return "default";
}

function isPublicClassMember(member) {
  if (!("modifiers" in member) || !member.modifiers) return true;
  for (const m of member.modifiers) {
    if (m.kind === ts.SyntaxKind.PrivateKeyword) return false;
    if (m.kind === ts.SyntaxKind.ProtectedKeyword) return false;
  }
  return true;
}

function resolveAliasedSymbol(checker, symbol) {
  if (!symbol) return symbol;
  if (symbol.flags & ts.SymbolFlags.Alias) {
    try {
      return checker.getAliasedSymbol(symbol);
    } catch {
      return symbol;
    }
  }
  return symbol;
}

function getExportedDeclarations({ checker, sf }) {
  const moduleSymbol = checker.getSymbolAtLocation(sf) ?? sf.symbol;
  if (!moduleSymbol) return [];
  const exports = checker.getExportsOfModule(moduleSymbol) ?? [];
  const decls = [];

  for (const ex of exports) {
    const sym = resolveAliasedSymbol(checker, ex);
    const ds = sym.getDeclarations() ?? [];
    for (const d of ds) decls.push(d);
  }
  return decls;
}

function findOwningStatementForVariableDecl(decl) {
  // Sobe até VariableStatement para inserir o doc uma vez por declaração exportada.
  let cur = decl;
  while (cur && !ts.isVariableStatement(cur)) cur = cur.parent;
  return cur;
}

function computeInsertionsForSourceFile({ checker, sf, text, fileRel }) {
  const insertions = [];
  const exportedDecls = getExportedDeclarations({ checker, sf });

  // Cobrir o padrão: `const Foo = ...; export default Foo;`
  // Nesse caso, o "export default" é um ExportAssignment e a declaração real pode não ter
  // modifier `export`. Descobrimos o símbolo e documentamos a declaração de origem no MESMO arquivo.
  const extraDecls = [];
  for (const st of sf.statements) {
    if (!ts.isExportAssignment(st)) continue;
    const expr = st.expression;
    if (!expr || !ts.isIdentifier(expr)) continue;
    const sym = resolveAliasedSymbol(checker, checker.getSymbolAtLocation(expr));
    const ds = sym?.getDeclarations?.() ?? [];
    for (const d of ds) extraDecls.push(d);
  }

  const allDecls = [...exportedDecls, ...extraDecls];

  const seen = new Set();
  function addInsertion(node, jsdoc) {
    const key = `${node.pos}:${node.end}:${jsdoc.slice(0, 40)}`;
    if (seen.has(key)) return;
    seen.add(key);

    const insertPos = node.getStart(sf, false);
    const indent = getIndent(text, insertPos);
    const doc = jsdoc
      .split("\n")
      .map((l) => (l.length ? indent + l : l))
      .join("\n");
    insertions.push({ pos: insertPos, text: doc + "\n" });
  }

  // 1) Docstrings para funções/classes exportadas (inclui default export por alias).
  for (const decl of allDecls) {
    // IMPORTANTE: símbolos re-exportados podem ter declaração em OUTRO arquivo.
    // Neste caso, a documentação será inserida quando processarmos o arquivo de origem.
    if (decl.getSourceFile() !== sf) continue;

    if (ts.isFunctionDeclaration(decl)) {
      if (hasLeadingJSDoc(text, decl, sf)) continue;
      const name = getNodeName(decl, sf);
      const params = decl.parameters.map((p) => ({
        name: p.name.getText(sf),
        type: getParamTypeString(checker, p) ?? (p.type ? p.type.getText(sf) : null),
      }));
      const returnType = getSignatureReturnTypeString(checker, decl) ?? (decl.type ? decl.type.getText(sf) : "unknown");
      addInsertion(
        decl,
        buildJsDoc({ kind: "function", name, params, returnType, fileRel })
      );
      continue;
    }

    if (ts.isClassDeclaration(decl)) {
      if (!hasLeadingJSDoc(text, decl, sf)) {
        const name = getNodeName(decl, sf);
        addInsertion(
          decl,
          buildJsDoc({ kind: "class", name, params: [], returnType: null, fileRel })
        );
      }

      // 2) Métodos públicos da classe exportada.
      for (const member of decl.members) {
        if (!isPublicClassMember(member)) continue;
        if (ts.isConstructorDeclaration(member)) {
          if (member.parameters.length === 0) continue;
          if (hasLeadingJSDoc(text, member, sf)) continue;
          const name = getNodeName(member, sf);
          const params = member.parameters.map((p) => ({
            name: p.name.getText(sf),
            type: getParamTypeString(checker, p) ?? (p.type ? p.type.getText(sf) : null),
          }));
          addInsertion(
            member,
            buildJsDoc({ kind: "constructor", name, params, returnType: "void", fileRel })
          );
          continue;
        }
        if (ts.isMethodDeclaration(member)) {
          if (hasLeadingJSDoc(text, member, sf)) continue;
          const name = getNodeName(member, sf);
          const params = member.parameters.map((p) => ({
            name: p.name.getText(sf),
            type: getParamTypeString(checker, p) ?? (p.type ? p.type.getText(sf) : null),
          }));
          const returnType =
            getSignatureReturnTypeString(checker, member) ?? (member.type ? member.type.getText(sf) : "unknown");
          addInsertion(
            member,
            buildJsDoc({ kind: "method", name, params, returnType, fileRel })
          );
          continue;
        }
      }
      continue;
    }

    // 3) `export const foo = (...) => ...`
    if (ts.isVariableDeclaration(decl)) {
      const init = decl.initializer;
      if (!init || (!ts.isArrowFunction(init) && !ts.isFunctionExpression(init))) continue;
      const stmt = findOwningStatementForVariableDecl(decl);
      if (!stmt) continue;
      if (hasLeadingJSDoc(text, stmt, sf)) continue;
      const name = decl.name.getText(sf);
      const params = init.parameters.map((p) => ({
        name: p.name.getText(sf),
        type: getParamTypeString(checker, p) ?? (p.type ? p.type.getText(sf) : null),
      }));
      const returnType =
        getSignatureReturnTypeString(checker, init) ??
        getSignatureReturnTypeString(checker, decl) ??
        "unknown";
      addInsertion(
        stmt,
        buildJsDoc({ kind: "function", name, params, returnType, fileRel })
      );
      continue;
    }

    // 4) default export por identificador: `export default Foo`
    if (ts.isExportAssignment(decl)) {
      // Normalmente o símbolo exportado chega aqui, mas só por garantia.
      continue;
    }
  }

  return insertions;
}

function applyInsertions(text, insertions) {
  if (!insertions.length) return text;
  // Inserir de trás pra frente para não invalidar posições.
  insertions.sort((a, b) => b.pos - a.pos);
  let out = text;
  for (const ins of insertions) {
    out = out.slice(0, ins.pos) + ins.text + out.slice(ins.pos);
  }
  return out;
}

function main() {
  const cfg = readTsConfig(TSCONFIG_PATH);

  // Base: arquivos do tsconfig + fallback de varredura do repo (inclui `test/` e pastas fora do include).
  const filesFromConfig = new Set(cfg.fileNames.map((f) => path.resolve(f)));
  const filesFromWalk = new Set(walkDir(REPO_ROOT).map((f) => path.resolve(f)));
  const allFiles = [...new Set([...filesFromConfig, ...filesFromWalk])].filter(isSourceFile);

  const program = ts.createProgram({
    rootNames: allFiles,
    options: cfg.options,
  });
  const checker = program.getTypeChecker();

  let changedFiles = 0;
  let totalInsertions = 0;

  for (const sf of program.getSourceFiles()) {
    const fileName = path.resolve(sf.fileName);
    if (!isSourceFile(fileName)) continue;
    if (sf.isDeclarationFile) continue;
    if (!fileName.startsWith(REPO_ROOT)) continue;

    const text = fs.readFileSync(fileName, "utf8");
    const fileRel = path.relative(REPO_ROOT, fileName).replaceAll("\\", "/");
    const insertions = computeInsertionsForSourceFile({ checker, sf, text, fileRel });
    if (!insertions.length) continue;

    const updated = applyInsertions(text, insertions);
    if (updated !== text) {
      fs.writeFileSync(fileName, updated, "utf8");
      changedFiles += 1;
      totalInsertions += insertions.length;
    }
  }

  console.log(`[add-jsdoc] Arquivos alterados: ${changedFiles}`);
  console.log(`[add-jsdoc] Blocos JSDoc inseridos: ${totalInsertions}`);
}

main();


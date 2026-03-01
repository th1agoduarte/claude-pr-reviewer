# 🤖 Claude PR Reviewer — Azure DevOps Extension

Extensão para Azure DevOps que faz review automático de Pull Requests usando **Claude AI** via **subscription** (sem custo extra de API).

## ✨ Novidades v1.1.0

- 📄 **Review por arquivo** — comentários aparecem na aba "Files" da PR
- 🗑️ **Limpeza automática** — reviews anteriores são removidos antes de novos
- 🏷️ **Label "AI-Reviewed"** — adicionada automaticamente à PR
- 🔒 **Detecção de dados sensíveis** — verifica .md, .json, .yml por senhas/tokens/keys

## 📁 Estrutura do Projeto

```
claude-pr-reviewer/
├── vss-extension.json          # Manifest da extensão
├── build.sh                    # Script de build e empacotamento
├── task/
│   ├── task.json               # Definição da task (inputs, UI)
│   ├── package.json            # Dependências
│   ├── tsconfig.json           # Config TypeScript
│   └── src/
│       ├── index.ts            # Entry point — orquestra tudo
│       ├── azuredevops.ts      # API do Azure DevOps (diff, comentários)
│       ├── claude-runner.ts    # Instala e executa Claude Code CLI
│       └── prompts.ts          # Prompts de review (pt-br, en, es)
├── docs/
│   └── overview.md             # Página do Marketplace
├── examples/
│   └── azure-pipelines.yml     # Pipeline de exemplo
└── images/
    └── icon.png                # Ícone da extensão (128x128)
```

## 🛠️ Como Buildar

```bash
# 1. Clone o repo
git clone <repo-url>
cd claude-pr-reviewer

# 2. Execute o build
chmod +x build.sh
./build.sh
```

O script:
- Instala dependências e compila TypeScript
- Gera um GUID único para a task
- Cria o pacote `.vsix` em `./dist/`

## 📦 Como Publicar

### Opção A: Marketplace privado (recomendado para sua org)

```bash
# 1. Crie um Publisher em https://marketplace.visualstudio.com/manage
# 2. Atualize "publisher" no vss-extension.json
# 3. Gere um PAT com escopo "Marketplace (Publish)"
tfx extension publish --manifest-globs vss-extension.json --token SEU_PAT
```

### Opção B: Upload direto (sem marketplace)

1. Organization Settings → Extensions → Browse local extensions
2. Upload do arquivo `.vsix`

## 🔑 Configuração de Autenticação

### Via Subscription (recomendado — sem custo extra)

```bash
# No terminal onde Claude Code está logado:
claude setup-token
# Copie o token gerado
```

No Azure DevOps:
1. **Pipelines → Library → Variable Groups** → crie `claude-secrets`
2. Adicione `CLAUDE_OAUTH_TOKEN` com o token (marque como 🔒 secret)

### Via API Key (alternativa)

1. Gere uma key em https://console.anthropic.com
2. Armazene como `ANTHROPIC_API_KEY` nas variáveis do pipeline
3. Use `authMethod: 'apikey'` na task

## 📋 Permissões Necessárias

1. **Pipeline Settings** → "Allow scripts to access the OAuth token" ✅
2. **Project Settings → Repos → Security** → Build Service:
   - "Contribute to pull requests" ✅

## ⚡ Uso no Pipeline

### Review por arquivo (recomendado)

```yaml
- task: ClaudePRReview@1
  inputs:
    authMethod: 'subscription'
    oauthToken: $(CLAUDE_OAUTH_TOKEN)
    model: 'claude-sonnet-4-5-20250929'
    reviewLanguage: 'pt-br'
    perFileReview: true
    maxFileDiffSize: '10000'
    fileExtensions: 'ts,js,py,php,vue,cs,java,go,md,json,yml,yaml'
    customPrompt: 'Foque em segurança e performance'
  env:
    SYSTEM_ACCESSTOKEN: $(System.AccessToken)
```

### Review global (modo legado)

```yaml
- task: ClaudePRReview@1
  inputs:
    authMethod: 'subscription'
    oauthToken: $(CLAUDE_OAUTH_TOKEN)
    model: 'claude-sonnet-4-5-20250929'
    reviewLanguage: 'pt-br'
    perFileReview: false
  env:
    SYSTEM_ACCESSTOKEN: $(System.AccessToken)
```

Veja mais exemplos em `examples/azure-pipelines.yml`.

## ⚙️ Configurações

| Input | Descrição | Padrão |
|-------|-----------|--------|
| `authMethod` | `subscription` ou `apikey` | `subscription` |
| `model` | Modelo Claude (Sonnet, Opus, Haiku) | `claude-sonnet-4-5-20250929` |
| `reviewLanguage` | `pt-br`, `en`, `es` | `pt-br` |
| `fileExtensions` | Extensões a analisar | `ts,js,tsx,jsx,py,php,vue,cs,...` |
| `excludePaths` | Caminhos a ignorar | `node_modules,dist,build,vendor,...` |
| `maxDiffSize` | Max caracteres do diff total | `30000` |
| `maxFileDiffSize` | Max caracteres do diff por arquivo | `10000` |
| `customPrompt` | Instruções extras para o review | (vazio) |
| `maxTurns` | Turnos do Claude Code | `1` |
| `failOnError` | Falhar pipeline em erro | `false` |
| `postComment` | Postar na PR | `true` |
| `perFileReview` | Comentários por arquivo (aba Files) | `true` |

## 🧩 Customização

- **Idiomas**: `pt-br`, `en`, `es` — edite `src/prompts.ts` para adicionar mais
- **Filtros**: Configure extensões e exclusões diretamente na task
- **Prompt**: Use `customPrompt` para regras específicas do time
- **Modelo**: Sonnet (equilíbrio), Opus (melhor qualidade), Haiku (mais rápido)
- **Per-file vs Global**: Use `perFileReview: true` para feedback na aba Files

## 📝 Licença

MIT

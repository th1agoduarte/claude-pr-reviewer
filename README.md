# 🤖 Claude PR Reviewer — Azure DevOps Extension

Extensão para Azure DevOps que faz review automático de Pull Requests usando **Claude AI** via **subscription** (sem custo extra de API).

## ✨ Novidades v2.0.0

- 🔔 **Notificação no Teams** — envia Adaptive Card com resumo do review via webhook
- 📋 **Validação de especificação** — valida código contra Work Items linkados (descrição e critérios de aceite)
- 🟢 **Status condicional** — issues críticos/importantes ficam "Active" (requerem ação), sugestões ficam "Closed"
- 📏 **maxDiffSize aumentado** — padrão de 50.000 caracteres (antes 30.000)
- 📄 **Review por arquivo** — comentários na aba "Files" da PR (v1.1.0)
- 🗑️ **Limpeza automática** — reviews anteriores removidos antes de novos
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
│       ├── azuredevops.ts      # API do Azure DevOps (diff, comentários, WI, Teams)
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

### Primeira publicação

```bash
# 1. Crie um Publisher em https://marketplace.visualstudio.com/manage
# 2. Atualize "publisher" no vss-extension.json
# 3. Gere um PAT com escopo "Marketplace (Publish)"
tfx extension publish --manifest-globs vss-extension.json --token SEU_PAT
```

### Atualizar extensão (versões seguintes)

```bash
# Via linha de comando (recomendado)
tfx extension publish --manifest-globs vss-extension.json --token SEU_PAT

# Ou via painel web
# 1. Organization Settings → Extensions → Browse local extensions
# 2. Clique na extensão → "Update" → upload do novo .vsix
```

### Upload direto (sem marketplace)

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

### Review por arquivo com Teams e Work Items (completo)

```yaml
- task: ClaudePRReview@2
  inputs:
    authMethod: 'subscription'
    oauthToken: $(CLAUDE_OAUTH_TOKEN)
    model: 'claude-sonnet-4-5-20250929'
    reviewLanguage: 'pt-br'
    perFileReview: true
    fileExtensions: 'ts,js,py,php,vue,cs,java,go,md,json,yml,yaml'
    teamsWebhookUrl: $(TEAMS_WEBHOOK_URL)
    customPrompt: 'Foque em segurança e performance'
  env:
    SYSTEM_ACCESSTOKEN: $(System.AccessToken)
```

### Review por arquivo (básico)

```yaml
- task: ClaudePRReview@2
  inputs:
    authMethod: 'subscription'
    oauthToken: $(CLAUDE_OAUTH_TOKEN)
    model: 'claude-sonnet-4-5-20250929'
    reviewLanguage: 'pt-br'
    perFileReview: true
  env:
    SYSTEM_ACCESSTOKEN: $(System.AccessToken)
```

### Review global (modo legado)

```yaml
- task: ClaudePRReview@2
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
| `maxDiffSize` | Max caracteres do diff total | `50000` |
| `maxFileDiffSize` | Max caracteres do diff por arquivo | (sem limite) |
| `customPrompt` | Instruções extras para o review | (vazio) |
| `maxTurns` | Turnos do Claude Code | `1` |
| `failOnError` | Falhar pipeline em erro | `false` |
| `postComment` | Postar na PR | `true` |
| `perFileReview` | Comentários por arquivo (aba Files) | `true` |
| `teamsWebhookUrl` | URL do webhook do Teams (Adaptive Card) | (vazio) |

## 🔔 Notificação no Teams

Para receber resumos de review no Microsoft Teams:

1. No Teams, crie um **Workflow** (Power Automate) no canal desejado:
   - Canal → "..." → "Workflows" → "Post to a channel when a webhook request is received"
   - Copie a URL do webhook gerado
2. Armazene a URL como variável no Azure DevOps (ex: `TEAMS_WEBHOOK_URL`)
3. Configure na task: `teamsWebhookUrl: $(TEAMS_WEBHOOK_URL)`

Se a variável não estiver configurada ou estiver vazia, a notificação é simplesmente ignorada (sem erro).

## 📋 Validação de Especificação (Work Items)

Se a PR tiver Work Items linkados com **descrição** e/ou **critérios de aceite**, o Claude automaticamente:
- Inclui a especificação no contexto do review
- Valida se as mudanças de código atendem à especificação
- Reporta no resumo se algum arquivo não atende
- Adiciona notas de especificação nos comentários por arquivo

Isso funciona automaticamente — basta linkar Work Items à PR normalmente no Azure DevOps.

## 🟢 Status Condicional dos Comentários

Os comentários agora usam status inteligente:
- **Active** — se o arquivo tem issues 🔴 Críticos ou 🟡 Importantes (requer ação do desenvolvedor)
- **Closed** — se o arquivo tem apenas 🔵 Sugestões (informativo, não bloqueia)

## 🧩 Customização

- **Idiomas**: `pt-br`, `en`, `es` — edite `src/prompts.ts` para adicionar mais
- **Filtros**: Configure extensões e exclusões diretamente na task
- **Prompt**: Use `customPrompt` para regras específicas do time
- **Modelo**: Sonnet (equilíbrio), Opus (melhor qualidade), Haiku (mais rápido)
- **Per-file vs Global**: Use `perFileReview: true` para feedback na aba Files

## 📝 Licença

MIT

# Claude PR Reviewer

Extensão para Azure DevOps que analisa Pull Requests automaticamente usando **Claude AI** via subscription (Claude Code CLI). Sem custos extras de API — usa sua assinatura Pro/Max existente.

## ✨ Features

- 🤖 **Review automático de PRs** com Claude Sonnet, Opus ou Haiku
- 📄 **Comentários por arquivo** — feedback aparece diretamente na aba "Files" da PR
- 🗑️ **Limpeza automática** — reviews anteriores são removidos antes de postar novos
- 🏷️ **Label "AI-Reviewed"** — adicionada automaticamente à PR após o review
- 🌍 **Multi-idioma**: Português (BR), English, Español
- 🔑 **Usa sua subscription** — sem necessidade de API key separada
- 📁 **Filtros configuráveis** de extensões de arquivo e caminhos
- 🔒 **Detecção de dados sensíveis** — senhas, tokens, API keys em qualquer arquivo
- ⚙️ **Prompt customizável** para regras específicas do time

## 🚀 Quick Start

### 1. Gere seu OAuth Token

No seu terminal (onde Claude Code está instalado e logado):

```bash
claude setup-token
```

### 2. Configure o Token no Azure DevOps

Vá em **Pipelines → Library → Variable Groups** e crie:
- `CLAUDE_OAUTH_TOKEN` = token gerado (marque como **secret**)

### 3. Adicione ao Pipeline

```yaml
trigger: none
pr:
  branches:
    include: ['*']

pool:
  vmImage: 'ubuntu-latest'

steps:
  - checkout: self
    fetchDepth: 0

  - task: ClaudePRReview@1
    inputs:
      authMethod: 'subscription'
      oauthToken: $(CLAUDE_OAUTH_TOKEN)
      model: 'claude-sonnet-4-5-20250929'
      reviewLanguage: 'pt-br'
      perFileReview: true
    env:
      SYSTEM_ACCESSTOKEN: $(System.AccessToken)
```

### 4. Permissões

- **Pipeline Settings** → Habilite "Allow scripts to access the OAuth token"
- **Project Settings → Repos → Security** → Permita "Contribute to pull requests" para o Build Service

## 📸 Exemplo de Review

### Modo Per-File (padrão)

O Claude posta comentários **individuais por arquivo** na aba "Files" da PR:

> ### 🤖 Claude Review
>
> **Resumo:** Arquivo adiciona endpoint de autenticação com JWT.
>
> **Problemas:**
> - 🔴 **critical** (linha 42): Token JWT sem expiração definida
> - 🟡 **important** (linha 28): Query SQL sem prepared statement

Além disso, um **resumo global** é postado na aba "Overview":

> ## 🤖 Claude PR Review
>
> **5** arquivo(s) analisado(s), **2** com feedback.
>
> | Severidade | Quantidade |
> |------------|------------|
> | 🔴 Crítico | 1 |
> | 🟡 Importante | 2 |
> | 🔵 Sugestão | 1 |
> | **Total** | **4** |
>
> Veja os comentários detalhados na aba **Files** desta PR.

### Modo Global (legado)

Com `perFileReview: false`, o Claude posta um único comentário com o review completo.

## ⚙️ Configurações

| Input | Descrição | Padrão |
|-------|-----------|--------|
| `authMethod` | `subscription` ou `apikey` | `subscription` |
| `model` | Modelo Claude | Sonnet 4.5 |
| `reviewLanguage` | `pt-br`, `en`, `es` | `pt-br` |
| `fileExtensions` | Extensões a analisar | `ts,js,py,php,vue,cs,...` |
| `excludePaths` | Caminhos a ignorar | `node_modules,dist,...` |
| `maxDiffSize` | Max caracteres do diff total | `30000` |
| `maxFileDiffSize` | Max caracteres do diff por arquivo | `10000` |
| `customPrompt` | Instruções extras | (vazio) |
| `failOnError` | Falhar pipeline em erro | `false` |
| `postComment` | Postar na PR | `true` |
| `perFileReview` | Comentários por arquivo na aba Files | `true` |

## 🔐 Segurança

- Tokens e API keys **nunca são logados** — use variáveis secretas do Azure DevOps
- O diff é processado em memória e enviado diretamente ao Claude
- Nenhum dado é armazenado pela extensão
- Verifica automaticamente **todos os arquivos** (incluindo `.md`, `.json`, `.yml`) em busca de dados sensíveis

## 💰 Custo

Usando `authMethod: subscription`, os reviews consomem da sua cota da assinatura Pro/Max. Não há cobrança adicional por uso de API.

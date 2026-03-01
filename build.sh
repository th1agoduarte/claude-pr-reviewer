#!/bin/bash
set -e

echo "═══════════════════════════════════════════"
echo "  🔨 Build — Claude PR Reviewer Extension"
echo "═══════════════════════════════════════════"

# 1. Task: instalar deps e compilar
echo ""
echo "📦 Instalando dependências da task..."
cd task
npm install

echo "🔧 Compilando TypeScript..."
npm run build

echo "🧹 Limpando devDependencies..."
npm prune --production
cd ..

# 2. Gerar GUID se necessário (substitui placeholder no task.json)
if grep -q "a1b2c3d4-e5f6-7890-abcd-ef1234567890" task/task.json; then
  NEW_GUID=$(python3 -c "import uuid; print(str(uuid.uuid4()))" 2>/dev/null || uuidgen 2>/dev/null || echo "a1b2c3d4-e5f6-7890-abcd-ef1234567890")
  echo "🆔 Gerando GUID da task: $NEW_GUID"
  sed -i "s/a1b2c3d4-e5f6-7890-abcd-ef1234567890/$NEW_GUID/" task/task.json
fi

# 3. Verificar se tfx está instalado
if ! command -v tfx &> /dev/null; then
  echo "📥 Instalando tfx-cli..."
  npm install -g tfx-cli
fi

# 4. Gerar ícone placeholder se não existir
if [ ! -f images/icon.png ]; then
  echo "🎨 Gerando ícone placeholder..."
  mkdir -p images
  # Gera um PNG mínimo de 128x128 (pode substituir por um ícone real)
  python3 -c "
import struct, zlib

def create_png(width, height, color):
    def make_chunk(chunk_type, data):
        c = chunk_type + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)

    header = b'\x89PNG\r\n\x1a\n'
    ihdr = make_chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))

    raw = b''
    for y in range(height):
        raw += b'\x00'
        for x in range(width):
            raw += bytes(color)

    idat = make_chunk(b'IDAT', zlib.compress(raw))
    iend = make_chunk(b'IEND', b'')
    return header + ihdr + idat + iend

png = create_png(128, 128, (216, 180, 140))
with open('images/icon.png', 'wb') as f:
    f.write(png)
" 2>/dev/null && echo "  ✅ Ícone gerado" || echo "  ⚠️  Crie manualmente images/icon.png (128x128)"
fi

# 5. Empacotar extensão
echo ""
echo "📦 Empacotando extensão (.vsix)..."
tfx extension create --manifest-globs vss-extension.json --output-path ./dist/

echo ""
echo "═══════════════════════════════════════════"
echo "  ✅ Build concluído!"
echo "═══════════════════════════════════════════"
echo ""
echo "Arquivo .vsix gerado em ./dist/"
echo ""
echo "Para publicar:"
echo "  1. Crie um Publisher em https://marketplace.visualstudio.com/manage"
echo "  2. Atualize 'publisher' em vss-extension.json"
echo "  3. Execute:"
echo "     tfx extension publish --manifest-globs vss-extension.json --token SEU_PAT"
echo ""
echo "Para instalar localmente (sem publicar no marketplace):"
echo "  1. Vá em Organization Settings → Extensions"
echo "  2. Clique em 'Browse local extensions'"
echo "  3. Faça upload do .vsix"

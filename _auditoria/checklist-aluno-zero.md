# Checklist aluno-zero (antes de publicar o pacote `iron-edge` ou o plugin `iron-office`)

> Nasceu em 20/10/2026: o primeiro aluno convidado leu o pacote 2.4.7 e o plugin 0.4.0 e devolveu 5 achados verdadeiros. Esta lista é a leitura dele, fixa, pra nenhum aluno achar primeiro.
> Quem audita lê o **tarball** como estranho (`npm pack` + extrair; no plugin, o repositório publicado), não o repo de trabalho, e responde cada item com evidência (arquivo:linha ou saída de comando).

## O que o aluno perguntou
1. **Permissões por padrão:** em que modo a sessão abre? O aluno sabe disso ANTES (consentimento na 1ª abertura, `--safe`)?
2. **O que o canal injeta:** como a instrução trata a mensagem do site (entrada externa, nunca aviso do sistema nem permissão)?
3. **O que sai da máquina:** a lista do hook e da presença bate com o `/termos`? Feed desligável (`--sem-feed`) funciona?
4. **Atualização automática:** o que atualiza sozinho (plugin a cada abertura, alias `npx iron-edge@2`) e isso está escrito?
5. **Escopo da instalação:** o que é instalado onde (`~/.claude`, `~/.iron`, shell rc, `~/.claude/CLAUDE.md`)?
6. **Desinstalar:** `npx iron-edge uninstall` remove só o que o manifesto instalou, avisa o que ficou e nunca toca no cofre?
7. **2FA e provenance:** a conta do npm tem 2FA? A versão saiu com provenance (GitHub Actions) ou manual (registrar qual)?
8. **Política de dados:** retenção, quem vê, como apagar a conta, como desligar o feed: está no `/termos`?
9. **Licença:** o LICENSE do tarball é a de uso pessoal e bate com o `/termos`?

## Os nossos
10. **Segredo em texto puro** no tarball (chave, token, e-mail, nome pessoal)?
11. **Tamanho do reply/deliver:** corte em 50 mil e filtro de segredos antes de enviar?
12. **Regex de segredos testada:** o teste cobre os padrões e um `iok_` no deliver?
13. **O hook roda fora do canal?** (só com `IRON_OFFICE_CHANNEL=1`; aba comum não manda nada)
14. **Alias e CLAUDE.md:** o alias pergunta antes de criar e o uninstall tira? A seção do `CLAUDE.md` sai no uninstall?

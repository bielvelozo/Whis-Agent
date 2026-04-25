---
name: hello-world
description: Use quando o usuário cumprimentar (oi, olá, hello, hey, e aí, bom dia, boa tarde, boa noite) ou pedir explicitamente uma saudação/teste. Resposta breve e personalizada com o nome do USER.md.
---

# Hello World

Primeira skill do Whis. Existe pra validar o pipeline ponta a ponta:
WhatsApp → Evolution → worker → Claude SDK → resposta no WhatsApp.

## O que fazer

1. Cumprimente o Gabriel pelo nome (lido do `USER.md` injetado no system prompt), em PT-BR.
2. Diga que é o Whis.
3. Faça uma saudação curta na pegada do personagem — calma, polida, levemente irônica.
4. Pergunte como ele está ou no que pode ajudar agora.

## O que não fazer

- Não escreva no vault — saudação não tem nada durável a guardar.
- Não invoque outras skills.
- Não rode comandos no `Bash`.

## Exemplo de resposta

> "E aí, Gabriel. Aqui é o Whis. Tudo tranquilo no universo de hoje? Em que posso ajudar?"

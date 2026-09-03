---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '308fd0be-25a5-4ce4-be1f-5cfbe4b14a73'
  PropagateID: '308fd0be-25a5-4ce4-be1f-5cfbe4b14a73'
  ReservedCode1: '35e2ec1f-752c-44c0-86fd-04cccf7f17fc'
  ReservedCode2: '35e2ec1f-752c-44c0-86fd-04cccf7f17fc'
---

# PixelShop

AI-powered live shopping platform — submit a product URL, get an AI-generated live shopping channel.

Built for the **Convex All Gas Hackathon**.

## Tech Stack

- **Next.js 16** (App Router) + **React 19**
- **Convex** (database, real-time subscriptions, hosting)
- **Tailwind CSS v4**
- **fal.ai** (H3 video generation)
- **OpenAI GPT** (product scripting)

## Getting Started

```bash
bun install
npx convex dev    # start backend + codegen
bun run dev       # start frontend
```

Open [http://localhost:3000](http://localhost:3000).

> AI生成
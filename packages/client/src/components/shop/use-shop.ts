import { trpc } from "~/utils/trpc";
import type { RodSlug, BaitSlug } from "@hooked/shared";
import { playSfx } from "~/utils/audio";

export function useBuyRod() {
  const utils = trpc.useUtils();
  return trpc.shop.buyRod.useMutation({
    onSuccess: () => {
      playSfx("buySell");
      void utils.player.me.invalidate();
    },
  });
}

export function useBuyBait() {
  const utils = trpc.useUtils();
  return trpc.shop.buyBait.useMutation({
    onSuccess: () => {
      playSfx("buySell");
      void utils.player.me.invalidate();
    },
  });
}

export function useEquipRod() {
  const utils = trpc.useUtils();
  return trpc.shop.equipRod.useMutation({
    onSuccess: () => {
      void utils.player.me.invalidate();
    },
  });
}

export function useEquipBait() {
  const utils = trpc.useUtils();
  return trpc.shop.equipBait.useMutation({
    onSuccess: () => {
      void utils.player.me.invalidate();
    },
  });
}

export type { RodSlug, BaitSlug };

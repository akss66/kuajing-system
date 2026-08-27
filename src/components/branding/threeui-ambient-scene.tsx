"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

const EmeraldHorizonBackground = dynamic(
  () =>
    import("@designcodeio/threeui/components/EmeraldHorizonBackground").then(
      (module) => module.EmeraldHorizonBackground,
    ),
  { ssr: false },
);

const ParticleDrift = dynamic(
  () =>
    import("@designcodeio/threeui/components/ParticleDrift").then(
      (module) => module.ParticleDrift,
    ),
  { ssr: false },
);

type ThreeUiAmbientSceneProps = {
  className?: string;
  scene: "login" | "portal";
};

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return undefined;
    }

    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);

    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);

  return matches;
}

export function ThreeUiAmbientScene({
  className,
  scene,
}: ThreeUiAmbientSceneProps) {
  const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const activeViewport = useMediaQuery(
    scene === "login" ? "(min-width: 1024px)" : "(min-width: 768px)",
  );
  const enhanced = activeViewport && !prefersReducedMotion;

  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 overflow-hidden",
        scene === "portal" && "rounded-[inherit]",
        className,
      )}
      data-threeui-scene={scene}
      data-threeui-state={enhanced ? "enhanced" : "fallback"}
    >
      <div className="absolute inset-0" data-threeui-fallback />
      {enhanced ? (
        scene === "login" ? (
          <EmeraldHorizonBackground
            className="absolute inset-0 opacity-[0.82]"
            glow={0.84}
            hue={-18}
            speed={0.5}
            variation={0.82}
            vignette={1.08}
            waveScale={0.92}
          />
        ) : (
          <ParticleDrift
            brightness={0.96}
            className="absolute inset-0 opacity-[0.92]"
            density={0.76}
            length={0.94}
            mode="light"
            opacity={0.92}
            saturation={0.76}
            size={0.94}
            speed={0.58}
          />
        )
      ) : null}
      <div className="absolute inset-0" data-threeui-overlay />
    </div>
  );
}

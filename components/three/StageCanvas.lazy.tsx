"use client";

import dynamic from "next/dynamic";

export const StageCanvasLazy = dynamic(() => import("./StageCanvas"), { ssr: false });

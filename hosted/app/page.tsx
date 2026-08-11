import type { Metadata } from "next";
import { Application } from "./Application";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Credit Insurance Requests", description: "Internal request management for credit insurance approvals." };

export default function Home() { return <Application />; }

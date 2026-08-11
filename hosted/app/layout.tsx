import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";
import "./workflow.css";
import "./professional.css";

export async function generateMetadata():Promise<Metadata>{
  const requestHeaders=await headers();const host=requestHeaders.get("x-forwarded-host")??requestHeaders.get("host");const protocol=requestHeaders.get("x-forwarded-proto")??"https";const image=host?`${protocol}://${host}/og.png`:undefined;
  return {title:"Credit Insurance Requests",description:"Internal credit insurance request submission, review and approval tracking.",openGraph:{title:"Credit Insurance Requests",description:"Controlled submission, review and approval tracking.",type:"website",images:image?[{url:image,width:1733,height:909,alt:"Credit Insurance Requests"}]:[]},twitter:{card:"summary_large_image",title:"Credit Insurance Requests",description:"Controlled submission, review and approval tracking.",images:image?[image]:[]}};
}
export default function RootLayout({children}:Readonly<{children:React.ReactNode}>){return <html lang="en"><body>{children}</body></html>;}

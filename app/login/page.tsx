import { headers } from "next/headers";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

export default async function Login() {
  // Radar host gets a Radar-branded sign-in; Terrain host gets Terrain's.
  const host = (await headers()).get("host") ?? "";
  const radar = host.startsWith("radar.");
  return <LoginForm radar={radar} />;
}

import { Card, CardContent } from "@/components/ui/card";
import { AlertCircle } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm text-center">
        <CardContent className="pt-8 pb-6 px-6 flex flex-col items-center gap-4">
          <div className="w-14 h-14 rounded-2xl bg-destructive/10 flex items-center justify-center">
            <AlertCircle className="h-7 w-7 text-destructive" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-foreground">Page Not Found</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              The page you're looking for doesn't exist or has been moved.
            </p>
          </div>
          <Link href="/">
            <Button variant="default" className="mt-2">
              Back to EchoPath
            </Button>
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}

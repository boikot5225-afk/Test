import java.security.Security;
import org.bouncycastle.jce.provider.BouncyCastleProvider;
import top.nkbe.npatch.patch.NPatch;

/** Registers the BKS provider required by NPatch before invoking its CLI. */
public final class NPatchLauncher {
    private NPatchLauncher() {}

    public static void main(String[] args) throws Exception {
        if (Security.getProvider(BouncyCastleProvider.PROVIDER_NAME) == null) {
            Security.addProvider(new BouncyCastleProvider());
        }
        if (Security.getProvider(BouncyCastleProvider.PROVIDER_NAME) == null) {
            throw new IllegalStateException("Bouncy Castle provider registration failed");
        }
        NPatch.main(args);
    }
}

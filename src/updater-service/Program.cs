using System.Diagnostics;
using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddWindowsService(options => options.ServiceName = "KabinetteUpdater");
builder.Services.AddHostedService<UpdaterWorker>();
builder.Logging.ClearProviders();
await builder.Build().RunAsync();

internal sealed class UpdaterWorker : BackgroundService
{
    private const string Prefix = "http://127.0.0.1:4787/";
    private readonly HttpClient _http = new();
    private readonly string _dataDir;
    private readonly string _logPath;
    private readonly string _allowedHost;

    public UpdaterWorker()
    {
        _dataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "KabinetteNotes");
        _logPath = Path.Combine(_dataDir, "updater-service.log");
        _allowedHost = Environment.GetEnvironmentVariable("KABINETTE_UPDATE_HOST")?.Trim() ?? "";
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        Directory.CreateDirectory(_dataDir);
        Log($"Service gestart op {Prefix}.");

        using var listener = new HttpListener();
        listener.Prefixes.Add(Prefix);
        listener.Start();

        while (!stoppingToken.IsCancellationRequested)
        {
            HttpListenerContext context;
            try
            {
                context = await listener.GetContextAsync().WaitAsync(stoppingToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception error)
            {
                Log($"Listener fout: {error.Message}");
                continue;
            }

            _ = Task.Run(() => HandleAsync(context, stoppingToken), CancellationToken.None);
        }

        Log("Service gestopt.");
    }

    private async Task HandleAsync(HttpListenerContext context, CancellationToken stoppingToken)
    {
        try
        {
            if (context.Request.HttpMethod == "GET" && context.Request.Url?.AbsolutePath == "/health")
            {
                await JsonAsync(context, 200, new { ok = true, service = "KabinetteUpdater" });
                return;
            }

            if (context.Request.HttpMethod != "POST" || context.Request.Url?.AbsolutePath != "/update")
            {
                await JsonAsync(context, 404, new { ok = false, message = "Onbekend endpoint." });
                return;
            }

            using var reader = new StreamReader(context.Request.InputStream, context.Request.ContentEncoding);
            var body = await reader.ReadToEndAsync(stoppingToken);
            var request = JsonSerializer.Deserialize<UpdateRequest>(body, new JsonSerializerOptions
            {
                PropertyNameCaseInsensitive = true
            });

            if (!TryNormalizeUrl(request?.Url, out var uri, out var reason))
            {
                Log($"Update geweigerd: {reason}");
                await JsonAsync(context, 400, new { ok = false, message = reason });
                return;
            }

            _ = Task.Run(() => InstallAsync(uri!), CancellationToken.None);
            await JsonAsync(context, 202, new { ok = true, message = "Update geaccepteerd door service." });
        }
        catch (Exception error)
        {
            Log($"Request fout: {error}");
            await JsonAsync(context, 500, new { ok = false, message = error.Message });
        }
    }

    private bool TryNormalizeUrl(string? rawUrl, out Uri? uri, out string reason)
    {
        uri = null;
        reason = "";

        if (!Uri.TryCreate(rawUrl, UriKind.Absolute, out var parsed))
        {
            reason = "Update URL is ongeldig.";
            return false;
        }

        if (parsed.Scheme != Uri.UriSchemeHttp && parsed.Scheme != Uri.UriSchemeHttps)
        {
            reason = "Update URL moet http of https zijn.";
            return false;
        }

        if (!string.IsNullOrWhiteSpace(_allowedHost) && !parsed.Host.Equals(_allowedHost, StringComparison.OrdinalIgnoreCase))
        {
            reason = $"Update host {parsed.Host} is niet toegestaan. Verwachte host: {_allowedHost}.";
            return false;
        }

        var builder = new UriBuilder(parsed)
        {
            Path = "/updates/client-setup.exe",
            Query = "",
            Fragment = ""
        };
        uri = builder.Uri;
        return true;
    }

    private async Task InstallAsync(Uri uri)
    {
        try
        {
            var updateDir = Path.Combine(Path.GetTempPath(), "KabinetteNotesServiceUpdate");
            Directory.CreateDirectory(updateDir);
            var installerPath = Path.Combine(updateDir, "KabinetteNotesClientSetup.exe");

            Log($"Download gestart: {uri}");
            await using (var input = await _http.GetStreamAsync(uri))
            await using (var output = File.Create(installerPath))
            {
                await input.CopyToAsync(output);
            }
            Log($"Download klaar: {new FileInfo(installerPath).Length} bytes.");

            foreach (var process in Process.GetProcessesByName("Kabinette Notes Client"))
            {
                try
                {
                    Log($"Client proces stoppen: {process.Id}");
                    process.Kill(entireProcessTree: true);
                }
                catch (Exception error)
                {
                    Log($"Client proces stoppen mislukt: {error.Message}");
                }
            }

            await Task.Delay(TimeSpan.FromSeconds(2));
            var installer = Process.Start(new ProcessStartInfo
            {
                FileName = installerPath,
                Arguments = "/S",
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            });
            if (installer is null)
            {
                Log("Installer kon niet gestart worden.");
                return;
            }

            await installer.WaitForExitAsync();
            Log($"Installer klaar met exit code {installer.ExitCode}.");
        }
        catch (Exception error)
        {
            Log($"Installatiefout: {error}");
        }
    }

    private static async Task JsonAsync(HttpListenerContext context, int statusCode, object payload)
    {
        var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(payload));
        context.Response.StatusCode = statusCode;
        context.Response.ContentType = "application/json; charset=utf-8";
        context.Response.ContentLength64 = bytes.Length;
        await context.Response.OutputStream.WriteAsync(bytes);
        context.Response.Close();
    }

    private void Log(string message)
    {
        Directory.CreateDirectory(_dataDir);
        File.AppendAllText(_logPath, $"{DateTimeOffset.Now:yyyy-MM-dd HH:mm:ss zzz} {message}{Environment.NewLine}");
    }
}

internal sealed record UpdateRequest(string? Url);
